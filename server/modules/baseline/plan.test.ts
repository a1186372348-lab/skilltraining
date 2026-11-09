import { describe, expect, it } from "vitest";

import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";

import {
  DEFAULT_DEEPEN_CONFIDENCE_THRESHOLD,
  MAX_DEEPEN_DIMENSIONS,
  decideDeepenQuestions,
  planBaselineItems,
  primaryDimensionOf,
  type BaselineQuestionLite,
} from "./plan";

// 逐维题序与加深判定纯函数单测（T27 / D30 / BR-V2-6）：
// 题序 = ABILITY_DIMENSIONS 八维固定顺序；一维候选按 id 升序取第 1 道为主题、第 2 道为加深候选；
// 加深 = 该维首题 Score.confidence < 阈值（默认 70，可注入）→ 追加未用候选；
// 每维至多 1 次、总题数 ≤12（8 + 至多 4 维加深）；confidence 为 NULL/缺失不触发。

function q(id: string, firstTag?: string): BaselineQuestionLite {
  return { id, abilityTags: firstTag ? [firstTag, "辅测维度"] : [] };
}

/** 八维各 2 道候选的完整题库（id 升序 = 内容侧约定候选顺序） */
function fullPool(): BaselineQuestionLite[] {
  const pool: BaselineQuestionLite[] = [];
  ABILITY_DIMENSIONS.forEach((dimension, index) => {
    pool.push(q(`d${index}-a`, dimension));
    pool.push(q(`d${index}-b`, dimension));
  });
  return pool;
}

describe("primaryDimensionOf：主测维度取 abilityTags 首位标签", () => {
  it("首位标签即主测维度；脏数据（非数组/空数组/非字符串）返回 null", () => {
    expect(primaryDimensionOf(q("x", "用户理解"))).toBe("用户理解");
    expect(primaryDimensionOf({ id: "x", abilityTags: [] })).toBeNull();
    expect(primaryDimensionOf({ id: "x", abilityTags: null })).toBeNull();
    expect(primaryDimensionOf({ id: "x", abilityTags: [42] })).toBeNull();
  });
});

describe("planBaselineItems：八维固定顺序逐维取题（D30）", () => {
  it("乱序题库 → 题序按 ABILITY_DIMENSIONS 固定顺序；主测维度以 abilityTags 首位标签归位", () => {
    const pool = fullPool().reverse(); // 打乱：验证归位不依赖传入顺序
    const plan = planBaselineItems(pool);
    expect(plan.map((p) => p.dimension)).toEqual([...ABILITY_DIMENSIONS]);
    expect(plan[0].primary.id).toBe("d0-a");
    expect(plan[0].deepenCandidate?.id).toBe("d0-b");
  });

  it("一维多题按 id 升序取第 1 道为主题、第 2 道为加深候选；第 3 道起忽略", () => {
    const plan = planBaselineItems([
      q("zz-3", "用户理解"),
      q("aa-1", "用户理解"),
      q("mm-2", "用户理解"),
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0].primary.id).toBe("aa-1");
    expect(plan[0].deepenCandidate?.id).toBe("mm-2");
  });

  it("一维一题：deepenCandidate 为 null；某维无题该维跳过；空题库返回空计划", () => {
    const single = planBaselineItems([q("a1", "问题定义"), q("b1", "根因分析")]);
    expect(single.map((p) => p.dimension)).toEqual(["问题定义", "根因分析"]); // 八维顺序而非传入顺序
    expect(single[0].deepenCandidate).toBeNull();
    expect(planBaselineItems([])).toEqual([]);
  });

  it("abilityTags 脏数据的题不归入任何维度（防御，不崩）", () => {
    const plan = planBaselineItems([q("good", "用户理解"), { id: "bad", abilityTags: "不是数组" }]);
    expect(plan).toHaveLength(1);
    expect(plan[0].primary.id).toBe("good");
  });
});

describe("decideDeepenQuestions：confidence 加深判定（BR-V2-6）", () => {
  const plan = planBaselineItems(fullPool());

  it("confidence < 阈值触发加深并取该维未用候选；= 阈值不触发（边界等值）", () => {
    const confidence = new Map<string, number | null>([
      ["问题定义", 69],
      ["用户理解", 70], // 边界：不低不触发
      ["根因分析", 100],
    ]);
    const decisions = decideDeepenQuestions({ plan, confidenceByDimension: confidence });
    expect(decisions).toEqual([{ dimension: "问题定义", questionId: "d0-b" }]);
  });

  it("confidence 为 NULL 不触发（AI 输出波动不拉长测评）；未评分（缺失）不触发", () => {
    const confidence = new Map<string, number | null>([
      ["问题定义", null],
      ["用户理解", 10],
      // 根因分析未评分：缺 key
    ]);
    const decisions = decideDeepenQuestions({ plan, confidenceByDimension: confidence });
    expect(decisions).toEqual([{ dimension: "用户理解", questionId: "d1-b" }]);
  });

  it("该维无加深候选（一维一题）不触发；每维至多 1 题", () => {
    const sparsePlan = planBaselineItems([q("a1", "问题定义"), q("b1", "用户理解"), q("b2", "用户理解")]);
    const decisions = decideDeepenQuestions({
      plan: sparsePlan,
      confidenceByDimension: new Map([
        ["问题定义", 0], // 无候选
        ["用户理解", 0], // 有候选 b2
      ]),
    });
    expect(decisions).toEqual([{ dimension: "用户理解", questionId: "b2" }]);
    // 天然每维至多 1 题（同一维度重复满足也只出一题）
    expect(decisions.filter((d) => d.dimension === "用户理解")).toHaveLength(1);
  });

  it("0 维加深 = 8 题（原固定 8 题）；>4 维满足条件时按八维顺序至多 4 维（8+4=12 封顶）", () => {
    expect(
      decideDeepenQuestions({ plan, confidenceByDimension: new Map() }),
    ).toEqual([]); // 0 维加深
    const allLow = new Map<string, number | null>(
      ABILITY_DIMENSIONS.map((dimension) => [dimension, 0]),
    );
    const decisions = decideDeepenQuestions({ plan, confidenceByDimension: allLow });
    expect(decisions).toHaveLength(MAX_DEEPEN_DIMENSIONS); // 8 + 4 = 12 封顶
    expect(decisions.map((d) => d.dimension)).toEqual(ABILITY_DIMENSIONS.slice(0, 4) as string[]);
  });

  it("阈值可注入：threshold=50 时 60 分维度不触发；默认阈值常量 = 70", () => {
    expect(DEFAULT_DEEPEN_CONFIDENCE_THRESHOLD).toBe(70);
    const confidence = new Map<string, number | null>([["问题定义", 60]]);
    expect(
      decideDeepenQuestions({ plan, confidenceByDimension: confidence, threshold: 50 }),
    ).toEqual([]);
    expect(
      decideDeepenQuestions({ plan, confidenceByDimension: confidence, threshold: 70 }),
    ).toEqual([{ dimension: "问题定义", questionId: "d0-b" }]);
    // 降级开关：阈值 0 等效关闭加深（任务文件「失败与回滚」约定）
    expect(
      decideDeepenQuestions({
        plan,
        confidenceByDimension: new Map(ABILITY_DIMENSIONS.map((d) => [d, 0])),
        threshold: 0,
      }),
    ).toEqual([]);
  });
});

it("可靠原主题锚点优先且不修改输入，不合法锚点按原排序兜底", () => {
  const dimension = ABILITY_DIMENSIONS[0];
  const questions = [q("b", dimension), q("a", dimension)];
  const before = structuredClone(questions);
  const anchored = planBaselineItems(questions, [dimension], new Map([[dimension, "b"]]));
  expect(anchored[0]).toMatchObject({ primary: { id: "b" }, deepenCandidate: { id: "a" } });
  expect(questions).toEqual(before);
  const fallback = planBaselineItems(questions, [dimension], new Map([[dimension, "missing"]]));
  expect(fallback[0].primary.id).toBe("a");
});
