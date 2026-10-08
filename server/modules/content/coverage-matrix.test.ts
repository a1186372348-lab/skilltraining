import { describe, expect, it } from "vitest";

import {
  buildCoverageMatrix,
  DAILY_DIMENSION_TARGET,
  formatCoverageReport,
} from "./coverage-matrix.ts";
import type { QuestionFileResult } from "./load-questions.ts";
import {
  ABILITY_DIMENSIONS,
  questionContentSchema,
  type AbilityDimension,
  type QuestionContent,
} from "./question-schema.ts";

// 经 schema 解析的合法题目工厂：保证测试数据即运行时结构
function makeQuestion(
  id: string,
  overrides: {
    ability_tags?: AbilityDimension[];
    difficulty?: "基础" | "中等" | "挑战";
    domain?: string;
    kind?: "baseline" | "daily";
  } = {},
): QuestionContent {
  const tags = overrides.ability_tags ?? ["问题定义", "用户理解"];
  const dimensions = Object.fromEntries(tags.map((tag) => [tag, ["一", "二", "三"]]));
  return questionContentSchema.parse({
    id,
    title: `题目 ${id}`,
    case_title: `案例 ${id}`,
    case_background: {
      product: { text: "p", citations: [1] },
      audience: { text: "a", citations: [1] },
      scenario: { text: "s", citations: [1] },
      features: { text: "f", citations: [1] },
      status: { text: "c", citations: [1] },
    },
    case_sources: [{ id: 1, title: "来源", publisher: "官方", url: "https://example.com/s" }],
    main_question: "问？",
    ability_tags: tags,
    difficulty: overrides.difficulty ?? "中等",
    rubric: { dimensions, forbidden_leaks: ["x"] },
    hint_tree: [1, 2, 3, 4, 5].map((level) => ({
      level,
      stage: `阶段${level}`,
      question: `${level}？`,
    })),
    materials: {
      core: [
        { title: "t1", source: "s1", url: "https://example.com/1", summary: "m1" },
        { title: "t2", source: "s2", url: "https://example.com/2", summary: "m2" },
      ],
      extended: [
        { title: "t3", source: "s3", url: "https://example.com/3", summary: "m3" },
        { title: "t4", source: "s4", url: "https://example.com/4", summary: "m4" },
        { title: "t5", source: "s5", url: "https://example.com/5", summary: "m5" },
      ],
    },
    status: "draft",
    domain: overrides.domain ?? "工具/效率",
    ...(overrides.kind ? { kind: overrides.kind } : {}),
  });
}

function ok(content: QuestionContent): QuestionFileResult {
  return { file: `${content.id}.yaml`, ok: true, content, issues: [] };
}

function failed(file: string): QuestionFileResult {
  return { file, ok: false, content: null, issues: ["模拟校验失败"] };
}

describe("buildCoverageMatrix：分布统计（T33）", () => {
  it("空批次：全部计数为 0，每维度日常题缺口 = 达标线", () => {
    const matrix = buildCoverageMatrix([]);
    expect(matrix.total).toBe(0);
    expect(matrix.daily).toBe(0);
    expect(matrix.baseline).toBe(0);
    for (const d of ABILITY_DIMENSIONS) {
      expect(matrix.byDimensionTagHit[d]).toBe(0);
      expect(matrix.byDimensionPrimary[d]).toBe(0);
    }
    expect(matrix.byDifficulty).toEqual({ 基础: 0, 中等: 0, 挑战: 0 });
    expect(matrix.byDomain).toEqual({});
    expect(matrix.dimensionGaps).toHaveLength(8);
    for (const gap of matrix.dimensionGaps) {
      expect(gap.dailyCount).toBe(0);
      expect(gap.gap).toBe(DAILY_DIMENSION_TARGET);
    }
  });

  it("校验失败的结果不计入分布", () => {
    const matrix = buildCoverageMatrix([ok(makeQuestion("Q01")), failed("bad.yaml")]);
    expect(matrix.total).toBe(1);
  });

  it("维度分布双口径：标签命中计入全部标签，主测只计首标签", () => {
    const matrix = buildCoverageMatrix([
      ok(makeQuestion("Q01", { ability_tags: ["问题定义", "用户理解", "根因分析"] })),
      ok(makeQuestion("Q02", { ability_tags: ["用户理解", "问题定义"] })),
    ]);
    // 标签命中：一题的每个标签各 +1
    expect(matrix.byDimensionTagHit["问题定义"]).toBe(2);
    expect(matrix.byDimensionTagHit["用户理解"]).toBe(2);
    expect(matrix.byDimensionTagHit["根因分析"]).toBe(1);
    expect(matrix.byDimensionTagHit["方案设计"]).toBe(0);
    // 主测（首标签）：Q01 → 问题定义，Q02 → 用户理解
    expect(matrix.byDimensionPrimary["问题定义"]).toBe(1);
    expect(matrix.byDimensionPrimary["用户理解"]).toBe(1);
    expect(matrix.byDimensionPrimary["根因分析"]).toBe(0);
  });

  it("难度 × 领域 × 用途分布", () => {
    const matrix = buildCoverageMatrix([
      ok(makeQuestion("Q01", { difficulty: "基础", domain: "电商" })),
      ok(makeQuestion("Q02", { difficulty: "基础", domain: "电商" })),
      ok(makeQuestion("Q03", { difficulty: "挑战", domain: "出行" })),
      ok(makeQuestion("B1", { difficulty: "挑战", domain: "内容/社交", kind: "baseline" })),
    ]);
    expect(matrix.total).toBe(4);
    expect(matrix.daily).toBe(3);
    expect(matrix.baseline).toBe(1);
    expect(matrix.byDifficulty).toEqual({ 基础: 2, 中等: 0, 挑战: 2 });
    expect(matrix.byDomain).toEqual({ 电商: 2, 出行: 1, "内容/社交": 1 });
  });

  it("达标缺口只按日常题统计（标签命中口径）：baseline 不计入，达标维度 gap 为 0", () => {
    // 凑 6 道日常题命中「问题定义」，另加 1 道 baseline 命中「用户理解」
    const dailies = Array.from({ length: 6 }, (_, i) =>
      ok(makeQuestion(`Q${String(i + 1).padStart(2, "0")}`, { ability_tags: ["问题定义", "产品取舍"] })),
    );
    const baseline = ok(
      makeQuestion("B1", { ability_tags: ["用户理解", "问题定义"], kind: "baseline" }),
    );
    const matrix = buildCoverageMatrix([...dailies, baseline]);

    const gaps = Object.fromEntries(matrix.dimensionGaps.map((g) => [g.dimension, g]));
    expect(gaps["问题定义"].dailyCount).toBe(6);
    expect(gaps["问题定义"].gap).toBe(0); // 恰好达标
    expect(gaps["产品取舍"].dailyCount).toBe(6);
    expect(gaps["产品取舍"].gap).toBe(0);
    // 用户理解只有 baseline 命中，日常计数为 0
    expect(gaps["用户理解"].dailyCount).toBe(0);
    expect(gaps["用户理解"].gap).toBe(DAILY_DIMENSION_TARGET);
    // 完全无题维度
    expect(gaps["产品表达"].dailyCount).toBe(0);
    expect(gaps["产品表达"].gap).toBe(DAILY_DIMENSION_TARGET);
  });

  it("缺口 = 达标线 − 现有数（不为负）", () => {
    const dailies = Array.from({ length: 8 }, (_, i) =>
      ok(makeQuestion(`Q${String(i + 1).padStart(2, "0")}`, { ability_tags: ["方案设计", "指标与验证"] })),
    );
    const matrix = buildCoverageMatrix(dailies);
    const gaps = Object.fromEntries(matrix.dimensionGaps.map((g) => [g.dimension, g]));
    expect(gaps["方案设计"].dailyCount).toBe(8);
    expect(gaps["方案设计"].gap).toBe(0); // 超过达标线不出现负缺口
  });
});

describe("formatCoverageReport：CLI 报告输出（T33）", () => {
  it("报告包含双口径维度分布、难度分布、领域分布与缺口清单", () => {
    const matrix = buildCoverageMatrix([
      ok(makeQuestion("Q01", { ability_tags: ["问题定义", "用户理解"], difficulty: "基础", domain: "电商" })),
      ok(makeQuestion("B1", { ability_tags: ["根因分析", "产品表达"], difficulty: "挑战", domain: "内容/社交", kind: "baseline" })),
    ]);
    const report = formatCoverageReport(matrix);
    expect(report).toContain("覆盖矩阵");
    expect(report).toContain("问题定义");
    expect(report).toContain("产品表达");
    expect(report).toContain("基础");
    expect(report).toContain("挑战");
    expect(report).toContain("电商");
    expect(report).toContain("内容/社交");
    expect(report).toContain("缺口");
    // 报告稳定可 diff：再次生成结果一致
    expect(formatCoverageReport(matrix)).toBe(report);
  });
});
