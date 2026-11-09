import { describe, expect, it } from "vitest";

import { checkFollowupLeak, type LeakViolation } from "./followup-leak-check";

// 追问泄露规则检查单测（T28 切片 4，三查③规则化，D31）：
// 字面重合（归一化子串）+ 字数上限；命中 forbidden_leaks / Rubric 要点 / 超限 / 干净通过 / 边界等值。

const forbiddenLeaks = ["「补全省按键、Agent 省任务」的价值对比结论", "具体缓释设计清单"];
const rubricPoints = [
  "区分两类任务的差异",
  "识别写代码之外的时间消耗",
  "指出至少两项代价",
];

function questions(text: string): { role: "question" | "hint"; text: string }[] {
  return [{ role: "question", text }];
}

describe("字面重合：forbidden_leaks 与 Rubric 要点", () => {
  it("追问文本含 forbidden_leaks 原文片段 → 命中 forbidden_leak 违规", () => {
    const violations = checkFollowupLeak({
      items: questions("你考虑过「补全省按键、Agent 省任务」的价值对比结论吗？"),
      forbiddenLeaks,
      rubricPoints,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: "forbidden_leak", role: "question" });
    expect(violations[0].source).toContain("价值对比结论");
    expect(violations[0].excerpt.length).toBeGreaterThan(0);
  });

  it("提示文本含 Rubric 要点原文 → 命中 rubric_point 违规", () => {
    const violations = checkFollowupLeak({
      items: [{ role: "hint", text: "试着指出至少两项代价，再回头看你的结论。" }],
      forbiddenLeaks,
      rubricPoints,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: "rubric_point", role: "hint" });
  });

  it("归一化匹配：插入空白/标点差异仍命中（口径注释见实现）", () => {
    const violations = checkFollowupLeak({
      items: questions("区分两类任务 的　差异，想过吗？"), // 全角/半角空白扰动
      forbiddenLeaks,
      rubricPoints,
    });
    expect(violations.some((v) => v.kind === "rubric_point")).toBe(true);
  });

  it("过短要点（归一化 <4 字）不参与匹配（防误报）；干净文本通过", () => {
    const violations = checkFollowupLeak({
      items: questions("你的结论句是什么？证据在哪儿？"),
      forbiddenLeaks: ["价值"], // 过短，跳过
      rubricPoints: ["任务"], // 过短，跳过
    });
    expect(violations).toEqual([]);
    // 正常干净文本
    expect(
      checkFollowupLeak({
        items: questions("你提到效率提升——有可衡量的指标支撑吗？"),
        forbiddenLeaks,
        rubricPoints,
      }),
    ).toEqual([]);
  });
});

describe("字数上限（现有 followup 输出惯例：追问 ≤120 字、提示 ≤80 字）", () => {
  it("追问 120 字放行、121 字超限；提示 80 字放行、81 字超限（边界等值）", () => {
    const at120 = checkFollowupLeak({
      items: questions("问".repeat(120)),
      forbiddenLeaks: [],
      rubricPoints: [],
    });
    expect(at120).toEqual([]);
    const over120 = checkFollowupLeak({
      items: questions("问".repeat(121)),
      forbiddenLeaks: [],
      rubricPoints: [],
    });
    expect(over120).toHaveLength(1);
    expect(over120[0]).toMatchObject({ kind: "question_too_long", actual: 121, limit: 120 });

    const at80 = checkFollowupLeak({
      items: [{ role: "hint", text: "提".repeat(80) }],
      forbiddenLeaks: [],
      rubricPoints: [],
    });
    expect(at80).toEqual([]);
    const over80 = checkFollowupLeak({
      items: [{ role: "hint", text: "提".repeat(81) }],
      forbiddenLeaks: [],
      rubricPoints: [],
    });
    expect(over80[0]).toMatchObject({ kind: "hint_too_long", actual: 81, limit: 80 });
  });

  it("多条文本混合：逐条独立报告", () => {
    const violations: LeakViolation[] = checkFollowupLeak({
      items: [
        { role: "question", text: "问".repeat(121) },
        { role: "question", text: "干净追问" },
        { role: "hint", text: "提".repeat(81) },
      ],
      forbiddenLeaks: [],
      rubricPoints: [],
    });
    expect(violations.map((v) => v.kind)).toEqual(["question_too_long", "hint_too_long"]);
  });
});
