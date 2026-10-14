import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  ANSWER_QUALITIES,
  formatReferenceAnswerReport,
  loadReferenceAnswerDirectory,
  parseReferenceAnswerYaml,
  REVIEW_STATUS,
  referenceAnswerSchema,
} from "./reference-answers.ts";

const KNOWN_IDS = new Set(["Q01", "Q02", "B1"]);

function validAnswer() {
  return {
    question_id: "Q01",
    answers: [{ text: "参考答案正文。", quality: "high", note: "初始参考作答" }],
    review_status: "draft",
  };
}

describe("评分样本契约（T33 / D31 扩展：1~4 份表现水平分层样本）", () => {
  it("锁定 review_status 枚举", () => {
    expect([...REVIEW_STATUS]).toEqual(["draft", "approved"]);
  });

  it("锁定 quality 表现水平枚举", () => {
    expect([...ANSWER_QUALITIES]).toEqual(["high", "medium", "low"]);
  });

  it("接受合法样本：1 份 high draft 样本（单份天然满足分层约束）", () => {
    const r = parseReferenceAnswerYaml(
      "Q01.yaml",
      "question_id: Q01\nanswers:\n  - text: 参考答案正文。\n    quality: high\n    note: 初始参考作答\nreview_status: draft\n",
      KNOWN_IDS,
    );
    expect(r.ok).toBe(true);
    expect(r.answer).toEqual(validAnswer());
  });

  it("接受 4 份分层样本与 approved 状态", () => {
    const r = referenceAnswerSchema.safeParse({
      question_id: "Q01",
      answers: [
        { text: "立场 A 高质量答案。", quality: "high", note: "立场 A 高质量" },
        { text: "立场 B 高质量答案。", quality: "high", note: "立场 B 高质量" },
        { text: "写得流畅但依据不足的答案。", quality: "medium", note: "流畅但依据不足" },
        { text: "合理承认未知的答案。", quality: "low", note: "合理承认未知" },
      ],
      review_status: "approved",
    });
    expect(r.success).toBe(true);
  });

  it("旧格式（answers 为纯字符串数组）被拒绝", () => {
    expect(
      referenceAnswerSchema.safeParse({ ...validAnswer(), answers: ["参考答案正文。"] }).success,
    ).toBe(false);
    const r = parseReferenceAnswerYaml(
      "Q01.yaml",
      "question_id: Q01\nanswers:\n  - 参考答案正文。\nreview_status: draft\n",
      KNOWN_IDS,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join("\n")).toContain("answers");
  });

  it("人审定档后某题无 high 样本也可入库（T33 校准 R3：预设 high 只是编写意图）", () => {
    const r = referenceAnswerSchema.safeParse({
      ...validAnswer(),
      answers: [
        { text: "流畅但依据不足。", quality: "medium" },
        { text: "偏离题意的作答。", quality: "low" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("quality 全部相同被拒绝（多份样本必须覆盖不同表现水平）", () => {
    const allHigh = referenceAnswerSchema.safeParse({
      ...validAnswer(),
      answers: [
        { text: "高质量一。", quality: "high" },
        { text: "高质量二。", quality: "high" },
      ],
    });
    expect(allHigh.success).toBe(false);
    const allMedium = referenceAnswerSchema.safeParse({
      ...validAnswer(),
      answers: [
        { text: "中等一。", quality: "medium" },
        { text: "中等二。", quality: "medium" },
      ],
    });
    expect(allMedium.success).toBe(false);
    if (!allMedium.success) {
      expect(allMedium.error.issues.map((i) => i.message).join("\n")).toContain("全部相同");
    }
  });

  it("question_id 必须引用已存在的题目内容 id", () => {
    const raw = "question_id: Q99\nanswers:\n  - text: 正文。\n    quality: high\nreview_status: draft\n";
    const r = parseReferenceAnswerYaml("Q99.yaml", raw, KNOWN_IDS);
    expect(r.ok).toBe(false);
    expect(r.issues.join("\n")).toContain("Q99");
    expect(r.issues.join("\n")).toContain("不存在");
  });

  it("answers 数量限定 1~4 份：0 份与 5 份均被拒绝", () => {
    expect(
      referenceAnswerSchema.safeParse({ ...validAnswer(), answers: [] }).success,
    ).toBe(false);
    expect(
      referenceAnswerSchema.safeParse({
        ...validAnswer(),
        answers: [
          { text: "一", quality: "high" },
          { text: "二", quality: "medium" },
          { text: "三", quality: "low" },
          { text: "四", quality: "high" },
          { text: "五", quality: "medium" },
        ],
      }).success,
    ).toBe(false);
  });

  it("答案正文空串或纯空白被拒绝（trim 后非空）", () => {
    expect(
      referenceAnswerSchema.safeParse({ ...validAnswer(), answers: [{ text: "", quality: "high" }] })
        .success,
    ).toBe(false);
    expect(
      referenceAnswerSchema.safeParse({
        ...validAnswer(),
        answers: [{ text: "   ", quality: "high" }],
      }).success,
    ).toBe(false);
  });

  it("note 为可选评审注记：缺省通过，空串被拒绝", () => {
    expect(
      referenceAnswerSchema.safeParse({ ...validAnswer(), answers: [{ text: "正文。", quality: "high" }] })
        .success,
    ).toBe(true);
    expect(
      referenceAnswerSchema.safeParse({
        ...validAnswer(),
        answers: [{ text: "正文。", quality: "high", note: "" }],
      }).success,
    ).toBe(false);
  });

  it("quality 枚举之外的值被拒绝", () => {
    expect(
      referenceAnswerSchema.safeParse({
        ...validAnswer(),
        answers: [{ text: "正文。", quality: "excellent" }],
      }).success,
    ).toBe(false);
  });

  it("review_status 枚举之外的值被拒绝", () => {
    expect(
      referenceAnswerSchema.safeParse({ ...validAnswer(), review_status: "published" }).success,
    ).toBe(false);
  });

  it("未知字段被拒绝（strictObject，防笔误静默通过；样本项内同样严格）", () => {
    expect(
      referenceAnswerSchema.safeParse({ ...validAnswer(), score_band: [3, 4] }).success,
    ).toBe(false);
    expect(
      referenceAnswerSchema.safeParse({
        ...validAnswer(),
        answers: [{ text: "正文。", quality: "high", score: 5 }],
      }).success,
    ).toBe(false);
  });

  it("YAML 语法错误转可读 issue，不抛异常", () => {
    const r = parseReferenceAnswerYaml("Q01.yaml", "question_id: [未闭合\n", KNOWN_IDS);
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toContain("YAML 语法错误");
  });

  it("schema 校验失败经 parseReferenceAnswerYaml 转出带路径的可读 issue", () => {
    const raw = "question_id: Q01\nanswers:\n  - text: 正文。\n    quality: high\nreview_status: published\n";
    const r = parseReferenceAnswerYaml("Q01.yaml", raw, KNOWN_IDS);
    expect(r.ok).toBe(false);
    expect(r.answer).toBeNull();
    expect(r.issues.join("\n")).toContain("review_status");
  });

  it("YAML 不是对象（根路径校验失败）时 issue 路径标记为（根）", () => {
    const r = parseReferenceAnswerYaml("Q01.yaml", "- 数组项\n", KNOWN_IDS);
    expect(r.ok).toBe(false);
    expect(r.issues.join("\n")).toContain("(根)");
  });
});

describe("content/eval/ 目录加载校验（T33）", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "ref-answers-"));
    tempDirs.push(dir);
    return dir;
  }

  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("目录不存在时抛出可读错误", () => {
    expect(() => loadReferenceAnswerDirectory(path.join(tmpdir(), "不存在的目录-t33"), KNOWN_IDS)).toThrow(
      "目录不存在",
    );
  });

  it("空目录（无 yaml）返回空结果集", () => {
    expect(loadReferenceAnswerDirectory(makeTempDir(), KNOWN_IDS)).toEqual([]);
  });

  it("逐文件加载校验：合法与非法并存时各自出结果", () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, "Q01.yaml"),
      "question_id: Q01\nanswers:\n  - text: 正文一。\n    quality: high\nreview_status: approved\n",
    );
    writeFileSync(
      path.join(dir, "Q77.yaml"),
      "question_id: Q77\nanswers:\n  - text: 正文。\n    quality: high\nreview_status: draft\n",
    );
    writeFileSync(path.join(dir, ".gitkeep"), "");

    const results = loadReferenceAnswerDirectory(dir, KNOWN_IDS);
    expect(results).toHaveLength(2);
    const byFile = Object.fromEntries(results.map((r) => [path.basename(r.file), r]));
    expect(byFile["Q01.yaml"].ok).toBe(true);
    expect(byFile["Q01.yaml"].answer?.review_status).toBe("approved");
    expect(byFile["Q77.yaml"].ok).toBe(false); // 引用了不存在的题目
  });

  it("递归收集子目录中的 .yml 文件", () => {
    const dir = makeTempDir();
    mkdirSync(path.join(dir, "nested"));
    writeFileSync(
      path.join(dir, "nested", "Q02.yml"),
      "question_id: Q02\nanswers:\n  - text: 正文。\n    quality: high\nreview_status: draft\n",
    );
    const results = loadReferenceAnswerDirectory(dir, KNOWN_IDS);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].answer?.question_id).toBe("Q02");
  });
});

describe("标准答案校验报告（T33）", () => {
  it("空结果集给出明确提示", () => {
    expect(formatReferenceAnswerReport([])).toContain("0");
  });

  it("全部通过时输出汇总通过行", () => {
    const r1 = parseReferenceAnswerYaml(
      "Q01.yaml",
      "question_id: Q01\nanswers:\n  - text: 正文。\n    quality: high\nreview_status: draft\n",
      KNOWN_IDS,
    );
    const r2 = parseReferenceAnswerYaml(
      "Q02.yaml",
      "question_id: Q02\nanswers:\n  - text: 正文。\n    quality: high\nreview_status: approved\n",
      KNOWN_IDS,
    );
    expect(formatReferenceAnswerReport([r1, r2])).toContain("全部 2 份标准答案校验通过");
  });

  it("通过与失败都出现在报告中，失败带 issue 明细", () => {
    const okResult = parseReferenceAnswerYaml(
      "Q01.yaml",
      "question_id: Q01\nanswers:\n  - text: 正文。\n    quality: high\nreview_status: draft\n",
      KNOWN_IDS,
    );
    const badResult = parseReferenceAnswerYaml(
      "Q99.yaml",
      "question_id: Q99\nanswers:\n  - text: 正文。\n    quality: high\nreview_status: draft\n",
      KNOWN_IDS,
    );
    const report = formatReferenceAnswerReport([okResult, badResult]);
    expect(report).toContain("Q01.yaml");
    expect(report).toContain("Q99.yaml");
    expect(report).toContain("1/2");
  });
});
