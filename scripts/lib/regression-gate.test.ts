import { describe, expect, it } from "vitest";

import {
  aggregateConfirmRuns,
  confirmSampleRuns,
  evaluateFollowupSampleGate,
  mergeSampleRetry,
  evaluateFollowupGate,
  evaluateScoringGate,
  extractScoringGateMetrics,
  formatRegressionReport,
  passKindLabel,
  type FollowupGateMetrics,
  type ScoringGateMetrics,
} from "./regression-gate";

// prompt 变更回归门槛纯函数单测（T28 / D31 切片 2）：
// 阈值边界（等于即放行）、放行/阻断、失败项文案；报告含逐样本明细与门槛判定结果。

const THRESHOLDS = { maeMax: 9.9, reversalsMax: 5, minSeparation: 20 } as const;
const FOLLOWUP_THRESHOLDS = { missMax: 0, harmRateMax: 0.2 } as const;

describe("evaluateScoringGate：scoring 套件门槛", () => {
  const ok: ScoringGateMetrics = { meanAbsDiff: 7.9, reversals: 5, minSeparationGap: 22 };

  it("全部达标（含边界等值）放行", () => {
    expect(evaluateScoringGate(ok, THRESHOLDS).passed).toBe(true);
    // 边界：等于阈值即放行
    expect(
      evaluateScoringGate({ meanAbsDiff: 9.9, reversals: 5, minSeparationGap: 20 }, THRESHOLDS).passed,
    ).toBe(true);
  });

  it("MAE 超上限阻断并写明失败项", () => {
    const verdict = evaluateScoringGate({ ...ok, meanAbsDiff: 10 }, THRESHOLDS);
    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0].metric).toContain("MAE");
    expect(verdict.failures[0].actual).toContain("10");
    expect(verdict.failures[0].threshold).toContain("9.9");
  });

  it("排序反转超上限阻断", () => {
    const verdict = evaluateScoringGate({ ...ok, reversals: 6 }, THRESHOLDS);
    expect(verdict.passed).toBe(false);
    expect(verdict.failures[0].metric).toContain("排序反转");
  });

  it("最小分离度不足阻断（取各题最小值口径）", () => {
    const verdict = evaluateScoringGate({ ...ok, minSeparationGap: 19.9 }, THRESHOLDS);
    expect(verdict.passed).toBe(false);
    expect(verdict.failures[0].metric).toContain("分离度");
  });

  it("多项不达标全部列出", () => {
    const verdict = evaluateScoringGate(
      { meanAbsDiff: 12, reversals: 9, minSeparationGap: 10 },
      THRESHOLDS,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toHaveLength(3);
  });

  it("人审对齐数据缺失（MAE null）或无可比题（分离度 null）阻断", () => {
    expect(evaluateScoringGate({ ...ok, meanAbsDiff: null }, THRESHOLDS).passed).toBe(false);
    expect(evaluateScoringGate({ ...ok, minSeparationGap: null }, THRESHOLDS).passed).toBe(false);
  });
});

describe("evaluateFollowupGate：followup 套件门槛（T35 校准口径）", () => {
  const ok: FollowupGateMetrics = { missCount: 0, harmRate: 0.2 };

  it("放水 0 且误伤率不超上限（含边界等值）放行", () => {
    expect(evaluateFollowupGate(ok, FOLLOWUP_THRESHOLDS).passed).toBe(true);
  });

  it("放水数 > 0 即阻断（missMax=0 硬上限）", () => {
    const verdict = evaluateFollowupGate({ missCount: 1, harmRate: 0 }, FOLLOWUP_THRESHOLDS);
    expect(verdict.passed).toBe(false);
    expect(verdict.failures[0].metric).toContain("放水");
  });

  it("误伤率超上限阻断", () => {
    const verdict = evaluateFollowupGate({ missCount: 0, harmRate: 0.21 }, FOLLOWUP_THRESHOLDS);
    expect(verdict.passed).toBe(false);
    expect(verdict.failures[0].metric).toContain("误伤");
  });

  it("误伤率 null（人审无不该追问样本）放行并注明", () => {
    const verdict = evaluateFollowupGate({ missCount: 0, harmRate: null }, FOLLOWUP_THRESHOLDS);
    expect(verdict.passed).toBe(true);
  });
});

describe("extractScoringGateMetrics：从既有分析结果提取门槛输入", () => {
  it("MAE 取人审对齐 meanAbsDiff；反转取 pairStats.reversed；分离度取各题最小 separationGap", () => {
    const metrics = extractScoringGateMetrics(
      {
        questions: [
          { questionId: "B3", separationGap: 30 },
          { questionId: "B5", separationGap: 21 },
          { questionId: "B7", separationGap: null }, // 不参与
        ],
      } as never,
      { meanAbsDiff: 7.9, pairStats: { same: 10, tied: 1, reversed: 2 } } as never,
    );
    expect(metrics).toEqual({ meanAbsDiff: 7.9, reversals: 2, minSeparationGap: 21 });
  });

  it("全部题不可比时分离度为 null", () => {
    const metrics = extractScoringGateMetrics(
      { questions: [{ questionId: "B3", separationGap: null }] } as never,
      { meanAbsDiff: 5, pairStats: { same: 1, tied: 0, reversed: 0 } } as never,
    );
    expect(metrics.minSeparationGap).toBeNull();
  });
});

describe("formatRegressionReport：报告结构", () => {
  it("含套件/版本/模式头、门槛判定表（指标-实际值-阈值-结果）、逐样本明细、失败清单", () => {
    const markdown = formatRegressionReport({
      suite: "scoring",
      versionLabel: "v1",
      mode: "live",
      model: "deepseek-flash",
      generatedAt: new Date("2026-10-20T10:00:00Z"),
      thresholds: [
        { metric: "MAE（人审对齐平均绝对差）", actual: "7.9", threshold: "≤ 9.9", passed: true },
        { metric: "排序反转组数", actual: "6", threshold: "≤ 5", passed: false },
      ],
      verdictPassed: false,
      sampleRows: ["| B3#1 | S3 | high | 92 | 90 | -2 |"],
      failures: ["B5#2：网关超时"],
    });
    expect(markdown).toContain("scoring");
    expect(markdown).toContain("v1");
    expect(markdown).toContain("未通过");
    expect(markdown).toContain("排序反转组数");
    expect(markdown).toContain("B3#1");
    expect(markdown).toContain("网关超时");
  });

  it("全部通过时报告写明通过", () => {
    const markdown = formatRegressionReport({
      suite: "followup",
      versionLabel: "active",
      mode: "mock",
      model: "mock",
      generatedAt: new Date(),
      thresholds: [{ metric: "放水数", actual: "0", threshold: "≤ 0", passed: true }],
      verdictPassed: true,
      sampleRows: [],
      failures: [],
    });
    expect(markdown).toContain("通过");
    expect(markdown).not.toContain("未通过");
  });
});

describe("aggregateConfirmRuns：双跑确认聚合判定（T28 切片 2 补充）", () => {
  it("首跑通过 → first-pass（不复跑，无论 confirmRuns 配置）", () => {
    expect(aggregateConfirmRuns([{ passed: true }])).toEqual({ passKind: "first-pass", passed: true });
    expect(aggregateConfirmRuns([{ passed: true }, { passed: false }])).toEqual({
      passKind: "first-pass",
      passed: true,
    });
  });

  it("单跑未过（--confirm-runs 1 等价形态）→ blocked，退出码口径不变", () => {
    expect(aggregateConfirmRuns([{ passed: false }])).toEqual({ passKind: "blocked", passed: false });
  });

  it("首跑未过、复跑通过 → flaky-pass（抖动放行，passed=true）", () => {
    expect(aggregateConfirmRuns([{ passed: false }, { passed: true }])).toEqual({
      passKind: "flaky-pass",
      passed: true,
    });
  });

  it("两遍皆未过 → blocked（双跑阻断）", () => {
    expect(aggregateConfirmRuns([{ passed: false }, { passed: false }])).toEqual({
      passKind: "blocked",
      passed: false,
    });
  });

  it("passKind 文案：一遍过 / 抖动放行 / 双跑阻断", () => {
    expect(passKindLabel("first-pass")).toContain("一遍过");
    expect(passKindLabel("flaky-pass")).toContain("抖动放行");
    expect(passKindLabel("blocked")).toContain("双跑阻断");
  });
});

describe("formatRegressionReport：双跑确认报告扩展", () => {
  const base = {
    suite: "followup" as const,
    versionLabel: "v1",
    mode: "live" as const,
    model: "deepseek-flash",
    generatedAt: new Date("2026-10-20T12:00:00Z"),
    sampleRows: ["| B3#1 | S3 | followup | 追问 | agree | r |"],
    failures: [] as string[],
  };
  const run1Rows = [
    { metric: "放水数（人审该追问但判跳过）", actual: "0", threshold: "≤ 0", passed: true },
    { metric: "误伤率（人审不该追问但判追问）", actual: "40.0%", threshold: "≤ 20.0%", passed: false },
  ];
  const run2Rows = [
    { metric: "放水数（人审该追问但判跳过）", actual: "0", threshold: "≤ 0", passed: true },
    { metric: "误伤率（人审不该追问但判追问）", actual: "20.0%", threshold: "≤ 20.0%", passed: true },
  ];

  it("双跑：两遍指标并排（阈值表合并为 指标/阈值/首跑/复跑 列），结论标注三种结果之一", () => {
    const markdown = formatRegressionReport({
      ...base,
      thresholds: run1Rows,
      verdictPassed: true,
      confirmRuns: {
        passKind: "flaky-pass",
        runs: [
          { label: "首跑", thresholds: run1Rows, verdictPassed: false },
          { label: "复跑", thresholds: run2Rows, verdictPassed: true },
        ],
      },
    });
    expect(markdown).toContain("抖动放行");
    expect(markdown).toContain("首跑");
    expect(markdown).toContain("复跑");
    expect(markdown).toContain("40.0%");
    expect(markdown).toContain("20.0%");
    // 合并表头：指标 / 阈值 / 首跑 / 复跑
    expect(markdown).toMatch(/\| 指标 \| 阈值 \| 首跑 \| 复跑 \|/);
  });

  it("双跑阻断与一遍过的结论文案", () => {
    const blocked = formatRegressionReport({
      ...base,
      thresholds: run1Rows,
      verdictPassed: false,
      confirmRuns: {
        passKind: "blocked",
        runs: [
          { label: "首跑", thresholds: run1Rows, verdictPassed: false },
          { label: "复跑", thresholds: run1Rows, verdictPassed: false },
        ],
      },
    });
    expect(blocked).toContain("双跑阻断");
    const firstPass = formatRegressionReport({
      ...base,
      thresholds: run2Rows,
      verdictPassed: true,
      confirmRuns: { passKind: "first-pass", runs: [{ label: "首跑", thresholds: run2Rows, verdictPassed: true }] },
    });
    expect(firstPass).toContain("一遍过");
    expect(firstPass).not.toContain("| 复跑 |");
  });

  it("复跑明细经 extraSections 追加", () => {
    const markdown = formatRegressionReport({
      ...base,
      thresholds: run2Rows,
      verdictPassed: true,
      confirmRuns: {
        passKind: "flaky-pass",
        runs: [
          { label: "首跑", thresholds: run1Rows, verdictPassed: false },
          { label: "复跑", thresholds: run2Rows, verdictPassed: true },
        ],
      },
      extraSections: [{ title: "复跑逐样本明细", rows: ["| B12#1 | S1 | skip | 追问 | harm | r2 |"] }],
    });
    expect(markdown).toContain("复跑逐样本明细");
    expect(markdown).toContain("B12#1");
  });

  it("confirmRuns 缺省：报告与单跑格式逐字兼容（回归）", () => {
    const single = formatRegressionReport({
      ...base,
      thresholds: run1Rows,
      verdictPassed: false,
    });
    expect(single).toContain("未通过");
    expect(single).not.toContain("首跑");
    expect(single).not.toContain("双跑");
  });
});

describe("mergeSampleRetry：遍内定向补跑归并（T28 切片 2 选项 A）", () => {
  const first = {
    results: [
      { label: "B3#1", value: 90 },
      { label: "B3#2", value: 80 },
    ],
    failures: [
      { label: "B5#1", error: "非法 JSON" },
      { label: "B12#1", error: "缺维度" },
    ],
  };

  it("补跑成功样本并入结果（按 label 字典序），初次失败原因保留在 retriedSucceeded", () => {
    const merged = mergeSampleRetry(first, {
      results: [{ label: "B5#1", value: 70 }],
      failures: [{ label: "B12#1", error: "缺维度（补跑仍失败）" }],
    });
    expect(merged.results.map((r) => r.label)).toEqual(["B3#1", "B3#2", "B5#1"]);
    expect(merged.results.find((r) => r.label === "B5#1")?.value).toBe(70);
    expect(merged.retriedSucceeded).toEqual([{ label: "B5#1", firstError: "非法 JSON" }]);
    // 补跑后仍失败：计入失败数，错误原因为补跑后的
    expect(merged.failures).toEqual([{ label: "B12#1", error: "缺维度（补跑仍失败）" }]);
  });

  it("补跑全部成功：failures 为空（该遍「跑批失败样本数」归零）", () => {
    const merged = mergeSampleRetry(first, {
      results: [
        { label: "B5#1", value: 70 },
        { label: "B12#1", value: 60 },
      ],
      failures: [],
    });
    expect(merged.failures).toEqual([]);
    expect(merged.retriedSucceeded).toHaveLength(2);
    expect(merged.results).toHaveLength(4);
  });

  it("retry 为 null（--no-sample-retry 或无失败样本）：原样透传首跑结果", () => {
    const merged = mergeSampleRetry(first, null);
    expect(merged.results.map((r) => r.label)).toEqual(["B3#1", "B3#2"]);
    expect(merged.retriedSucceeded).toEqual([]);
    expect(merged.failures).toEqual(first.failures); // 失败原样计入
  });

  it("首跑无失败 + retry 非 null（防御调用）：归并不出错", () => {
    const clean = { results: [{ label: "B3#1", value: 90 }], failures: [] };
    const merged = mergeSampleRetry(clean, { results: [], failures: [] });
    expect(merged.results).toHaveLength(1);
    expect(merged.failures).toEqual([]);
  });
});

describe("formatRegressionReport：失败样本两类区分（初次失败补跑成功 / 补跑后仍失败）", () => {
  const base = {
    suite: "scoring" as const,
    versionLabel: "v1",
    mode: "live" as const,
    model: "deepseek-flash",
    generatedAt: new Date("2026-10-21T18:00:00Z"),
    thresholds: [{ metric: "跑批失败样本数", actual: "1", threshold: "= 0", passed: false }],
    verdictPassed: false,
    sampleRows: [] as string[],
    failures: ["B12#1：缺维度（补跑后仍失败）"],
  };

  it("两类分段渲染，各自标注错误原因", () => {
    const markdown = formatRegressionReport({
      ...base,
      retriedSucceeded: ["B5#1：非法 JSON（初次失败，定向补跑成功）"],
    });
    expect(markdown).toContain("初次失败、定向补跑成功");
    expect(markdown).toContain("B5#1");
    expect(markdown).toContain("非法 JSON");
    expect(markdown).toContain("补跑后仍失败");
    expect(markdown).toContain("B12#1");
    expect(markdown).toContain("缺维度");
  });

  it("retriedSucceeded 缺省：报告与旧版逐字兼容（回归）", () => {
    const markdown = formatRegressionReport(base);
    expect(markdown).toContain("失败样本（--only 定向补跑后重跑回归）");
    expect(markdown).not.toContain("初次失败、定向补跑成功");
  });
});

describe("confirmSampleRuns：样本级双跑确认（T28 切片 2 门禁补强，followup 计数型指标）", () => {
  const tasks = [
    { questionId: "B3", sampleIndex: 1, blindId: "S1" },
    { questionId: "B3", sampleIndex: 2, blindId: "S2" },
    { questionId: "B5", sampleIndex: 1, blindId: "S1" },
    { questionId: "B12", sampleIndex: 1, blindId: "S1" },
    { questionId: "B14", sampleIndex: 1, blindId: "S1" },
  ] as never;
  const human = {
    B3: { S1: "followup", S2: "skip" },
    B5: { S1: "followup" },
    B12: { S1: "skip" },
    B14: { S1: "gray" },
  } as never;
  const v = (machine: "followup" | "skip", reason = "理由") => ({ machine, reason });

  it("分类：确认放水（人审追问+所有遍跳过）/确认误伤（人审跳过+所有遍追问）/边界抖动（遍间不一致）/一致", () => {
    const result = confirmSampleRuns({
      tasks,
      human,
      runs: [
        // 首跑：B3#1 skip（人审追问）、B3#2 skip（人审跳过=一致）、B5#1 skip、B12#1 followup、B14#1 skip
        new Map([
          ["B3#1", v("skip")],
          ["B3#2", v("skip")],
          ["B5#1", v("skip", "首跑理由")],
          ["B12#1", v("followup", "首跑理由")],
          ["B14#1", v("skip")],
        ]),
        // 复跑：B3#1 skip（两遍一致=确认放水）、B5#1 followup（遍间翻转=抖动）、B12#1 skip（翻转=抖动）、B14#1 followup（灰区翻转=抖动）
        new Map([
          ["B3#1", v("skip")],
          ["B3#2", v("skip")],
          ["B5#1", v("followup", "复跑理由")],
          ["B12#1", v("skip", "复跑理由")],
          ["B14#1", v("followup")],
        ]),
      ],
    });
    const byLabel = new Map(result.rows.map((r) => [r.label, r]));
    expect(byLabel.get("B3#1")?.kind).toBe("confirmed-miss"); // 人审追问且两遍都跳过
    expect(byLabel.get("B3#2")?.kind).toBe("agree"); // 两遍一致且与人审一致
    expect(byLabel.get("B5#1")?.kind).toBe("flaky"); // 遍间翻转不计入失败
    expect(byLabel.get("B12#1")?.kind).toBe("flaky");
    expect(byLabel.get("B14#1")?.kind).toBe("flaky"); // 灰区遍间不一致同样进抖动清单
    expect(result.confirmedMissCount).toBe(1);
    expect(result.confirmedHarmCount).toBe(0);
    expect(result.flakyCount).toBe(3);
    expect(result.flakyRate).toBeCloseTo(3 / 5);
    expect(result.totalCount).toBe(5);
  });

  it("确认误伤：人审 skip 且所有遍 followup", () => {
    const result = confirmSampleRuns({
      tasks,
      human,
      runs: [
        new Map([["B3#1", v("followup")], ["B3#2", v("followup")], ["B5#1", v("followup")], ["B12#1", v("followup")], ["B14#1", v("skip")]]),
        new Map([["B3#1", v("followup")], ["B3#2", v("followup")], ["B5#1", v("followup")], ["B12#1", v("followup")], ["B14#1", v("skip")]]),
      ],
    });
    const byLabel = new Map(result.rows.map((r) => [r.label, r]));
    expect(byLabel.get("B3#2")?.kind).toBe("confirmed-harm"); // 人审 skip、两遍追问
    expect(byLabel.get("B12#1")?.kind).toBe("confirmed-harm");
    expect(result.confirmedHarmCount).toBe(2);
    // 分母仍为人审 skip 样本数（B3#2 + B12#1 = 2）
    expect(result.confirmedHarmRate).toBeCloseTo(1);
    expect(result.confirmedMissCount).toBe(0);
  });

  it("某遍缺判定（跑批失败残留）：该样本按边界抖动处理，理由标注缺失", () => {
    const result = confirmSampleRuns({
      tasks,
      human,
      runs: [
        new Map([["B3#1", v("skip")], ["B3#2", v("skip")], ["B5#1", v("skip")], ["B12#1", v("followup")], ["B14#1", v("skip")]]),
        new Map([["B3#1", v("skip")], ["B3#2", v("skip")], ["B5#1", v("followup")], ["B14#1", v("skip")]]),
        // 复跑缺 B12#1（该遍跑批失败）
      ],
    });
    const row = result.rows.find((r) => r.label === "B12#1")!;
    expect(row.kind).toBe("flaky");
    expect(row.runs.some((r) => r.machine === null)).toBe(true);
  });
});

describe("evaluateFollowupSampleGate：确认值门槛（含抖动率）", () => {
  const T = { missMax: 0, harmRateMax: 0.2, flakyRateMax: 0.15 } as const;
  const base: import("./regression-gate").SampleConfirmResult = {
    rows: [],
    confirmedMissCount: 0,
    confirmedHarmCount: 0,
    humanFollowupCount: 3,
    humanSkipCount: 5,
    confirmedHarmRate: 0,
    flakyCount: 2,
    flakyRate: 2 / 31,
    totalCount: 31,
  };

  it("确认放水 =0、确认误伤率 ≤20%、抖动率 ≤15%：放行（含边界等值）", () => {
    expect(evaluateFollowupSampleGate(base, T).passed).toBe(true);
    expect(
      evaluateFollowupSampleGate({ ...base, flakyRate: 0.15, confirmedHarmRate: 0.2 }, T).passed,
    ).toBe(true);
  });

  it("确认放水 ≥1 即阻断；确认误伤率超线阻断；抖动率超线阻断（即便确认值全 0）", () => {
    const miss = evaluateFollowupSampleGate({ ...base, confirmedMissCount: 1 }, T);
    expect(miss.passed).toBe(false);
    expect(miss.failures[0].metric).toContain("确认放水");
    const harm = evaluateFollowupSampleGate({ ...base, confirmedHarmCount: 2, confirmedHarmRate: 0.4 }, T);
    expect(harm.passed).toBe(false);
    expect(harm.failures[0].metric).toContain("确认误伤");
    const flaky = evaluateFollowupSampleGate({ ...base, flakyCount: 5, flakyRate: 5 / 31 }, T);
    expect(flaky.passed).toBe(false);
    expect(flaky.failures[0].metric).toContain("抖动率");
  });
});

describe("aggregateConfirmRuns：confirmed-pass 分支（优先级在 flaky-pass 之后）", () => {
  it("两遍单跑都未过 + 样本级确认达标 → confirmed-pass（passed=true）", () => {
    expect(
      aggregateConfirmRuns([{ passed: false }, { passed: false }], { sampleConfirmedPassed: true }),
    ).toEqual({ passKind: "confirmed-pass", passed: true });
  });

  it("复跑单跑全过仍记 flaky-pass（样本级确认不参与）；首跑过仍 first-pass", () => {
    expect(aggregateConfirmRuns([{ passed: false }, { passed: true }], { sampleConfirmedPassed: true })).toEqual({
      passKind: "flaky-pass",
      passed: true,
    });
    expect(aggregateConfirmRuns([{ passed: true }], { sampleConfirmedPassed: true })).toEqual({
      passKind: "first-pass",
      passed: true,
    });
  });

  it("两遍都未过且样本级确认未达标/未提供 → blocked（向后兼容）", () => {
    expect(aggregateConfirmRuns([{ passed: false }, { passed: false }], { sampleConfirmedPassed: false })).toEqual({
      passKind: "blocked",
      passed: false,
    });
    expect(aggregateConfirmRuns([{ passed: false }, { passed: false }])).toEqual({
      passKind: "blocked",
      passed: false,
    });
  });

  it("passKindLabel：confirmed-pass 文案醒目", () => {
    expect(passKindLabel("confirmed-pass")).toContain("确认放行");
  });
});

describe("formatRegressionReport：样本级确认与边界抖动区块", () => {
  const base = {
    suite: "followup" as const,
    versionLabel: "v3",
    mode: "live" as const,
    model: "deepseek-flash",
    generatedAt: new Date("2026-10-22T10:00:00Z"),
    thresholds: [{ metric: "放水数（人审该追问但判跳过）", actual: "1", threshold: "≤ 0", passed: false }],
    verdictPassed: true,
    sampleRows: ["| B5#1 | S2 | followup | 跳过 | miss | r1 |"],
    failures: [] as string[],
    confirmRuns: {
      passKind: "confirmed-pass" as const,
      runs: [
        { label: "首跑", thresholds: [{ metric: "放水数（人审该追问但判跳过）", actual: "1", threshold: "≤ 0", passed: false }], verdictPassed: false },
        { label: "复跑1", thresholds: [{ metric: "放水数（人审该追问但判跳过）", actual: "0", threshold: "≤ 0", passed: true }], verdictPassed: false },
      ],
    },
  };

  it("含「样本级确认判定」阈值行与「边界抖动清单」（各遍判定与理由摘要）", () => {
    const markdown = formatRegressionReport({
      ...base,
      sampleConfirm: {
        thresholdRows: [
          { metric: "确认放水数（两遍一致）", actual: "0", threshold: "≤ 0", passed: true },
          { metric: "确认误伤率（两遍一致）", actual: "0.0%", threshold: "≤ 20.0%", passed: true },
          { metric: "边界抖动率", actual: "3.2%", threshold: "≤ 15.0%", passed: true },
        ],
        confirmedLines: ["- B3#1（S3）：人审该追问，两遍均跳过（确认放水）"],
        flakyLines: ["- B5#1（S2）：人审该追问；首跑 跳过（理由A…）/ 复跑 追问（理由B…）"],
      },
    });
    expect(markdown).toContain("确认放行");
    expect(markdown).toContain("样本级确认判定");
    expect(markdown).toContain("确认放水数（两遍一致）");
    expect(markdown).toContain("边界抖动清单");
    expect(markdown).toContain("B5#1");
    expect(markdown).toContain("理由A");
  });

  it("sampleConfirm 缺省：不出现新区块（向后兼容）", () => {
    const markdown = formatRegressionReport(base);
    expect(markdown).not.toContain("样本级确认判定");
    expect(markdown).not.toContain("边界抖动清单");
  });
});

describe("confirmSampleRuns：样本级双跑确认（T28 切片 2 门禁补强，followup 计数型指标）", () => {
  const tasks = [
    { questionId: "B3", sampleIndex: 1, blindId: "S1" },
    { questionId: "B3", sampleIndex: 2, blindId: "S2" },
    { questionId: "B5", sampleIndex: 1, blindId: "S1" },
    { questionId: "B12", sampleIndex: 1, blindId: "S1" },
    { questionId: "B14", sampleIndex: 1, blindId: "S1" },
  ] as never;
  const human = {
    B3: { S1: "followup", S2: "skip" },
    B5: { S1: "followup" },
    B12: { S1: "skip" },
    B14: { S1: "gray" },
  } as never;
  const v = (machine: "followup" | "skip", reason = "理由") => ({ machine, reason });

  it("分类：确认放水（人审追问+所有遍跳过）/确认误伤（人审跳过+所有遍追问）/边界抖动（遍间不一致）/一致", () => {
    const result = confirmSampleRuns({
      tasks,
      human,
      runs: [
        new Map([
          ["B3#1", v("skip")],
          ["B3#2", v("skip")],
          ["B5#1", v("skip", "首跑理由")],
          ["B12#1", v("followup", "首跑理由")],
          ["B14#1", v("skip")],
        ]),
        new Map([
          ["B3#1", v("skip")],
          ["B3#2", v("skip")],
          ["B5#1", v("followup", "复跑理由")],
          ["B12#1", v("skip", "复跑理由")],
          ["B14#1", v("followup")],
        ]),
      ],
    });
    const byLabel = new Map(result.rows.map((r) => [r.label, r]));
    expect(byLabel.get("B3#1")?.kind).toBe("confirmed-miss"); // 人审追问且两遍都跳过
    expect(byLabel.get("B3#2")?.kind).toBe("agree"); // 两遍一致且与人审一致
    expect(byLabel.get("B5#1")?.kind).toBe("flaky"); // 遍间翻转不计入失败
    expect(byLabel.get("B12#1")?.kind).toBe("flaky");
    expect(byLabel.get("B14#1")?.kind).toBe("flaky"); // 灰区遍间不一致同样进抖动清单
    expect(result.confirmedMissCount).toBe(1);
    expect(result.confirmedHarmCount).toBe(0);
    expect(result.flakyCount).toBe(3);
    expect(result.flakyRate).toBeCloseTo(3 / 5);
    expect(result.totalCount).toBe(5);
  });

  it("确认误伤：人审 skip 且所有遍 followup；分母为人审 skip 样本数", () => {
    const allFollowup = new Map([
      ["B3#1", v("followup")],
      ["B3#2", v("followup")],
      ["B5#1", v("followup")],
      ["B12#1", v("followup")],
      ["B14#1", v("skip")],
    ]);
    const result = confirmSampleRuns({ tasks, human, runs: [allFollowup, new Map(allFollowup)] });
    const byLabel = new Map(result.rows.map((r) => [r.label, r]));
    expect(byLabel.get("B3#2")?.kind).toBe("confirmed-harm");
    expect(byLabel.get("B12#1")?.kind).toBe("confirmed-harm");
    expect(result.confirmedHarmCount).toBe(2);
    expect(result.confirmedHarmRate).toBeCloseTo(1); // 分母 = 人审 skip 样本数（2）
    expect(result.confirmedMissCount).toBe(0);
  });

  it("某遍缺判定（跑批失败残留）：该样本按边界抖动处理，理由标注缺失", () => {
    const result = confirmSampleRuns({
      tasks,
      human,
      runs: [
        new Map([
          ["B3#1", v("skip")],
          ["B3#2", v("skip")],
          ["B5#1", v("skip")],
          ["B12#1", v("followup")],
          ["B14#1", v("skip")],
        ]),
        new Map([
          ["B3#1", v("skip")],
          ["B3#2", v("skip")],
          ["B5#1", v("followup")],
          ["B14#1", v("skip")],
          // 复跑缺 B12#1（该遍跑批失败）
        ]),
      ],
    });
    const row = result.rows.find((r) => r.label === "B12#1")!;
    expect(row.kind).toBe("flaky");
    expect(row.runs.some((r) => r.machine === null)).toBe(true);
  });
});

describe("evaluateFollowupSampleGate：确认值门槛（含抖动率）", () => {
  const T = { missMax: 0, harmRateMax: 0.2, flakyRateMax: 0.15 } as const;
  const base: import("./regression-gate").SampleConfirmResult = {
    rows: [],
    confirmedMissCount: 0,
    confirmedHarmCount: 0,
    humanFollowupCount: 3,
    humanSkipCount: 5,
    confirmedHarmRate: 0,
    flakyCount: 2,
    flakyRate: 2 / 31,
    totalCount: 31,
  };

  it("确认放水 =0、确认误伤率 ≤20%、抖动率 ≤15%：放行（含边界等值）", () => {
    expect(evaluateFollowupSampleGate(base, T).passed).toBe(true);
    expect(
      evaluateFollowupSampleGate({ ...base, flakyRate: 0.15, confirmedHarmRate: 0.2 }, T).passed,
    ).toBe(true);
  });

  it("确认放水 ≥1 即阻断；确认误伤率超线阻断；抖动率超线阻断（即便确认值全 0）", () => {
    const miss = evaluateFollowupSampleGate({ ...base, confirmedMissCount: 1 }, T);
    expect(miss.passed).toBe(false);
    expect(miss.failures[0].metric).toContain("确认放水");
    const harm = evaluateFollowupSampleGate({ ...base, confirmedHarmCount: 2, confirmedHarmRate: 0.4 }, T);
    expect(harm.passed).toBe(false);
    expect(harm.failures[0].metric).toContain("确认误伤");
    const flaky = evaluateFollowupSampleGate({ ...base, flakyCount: 5, flakyRate: 5 / 31 }, T);
    expect(flaky.passed).toBe(false);
    expect(flaky.failures[0].metric).toContain("抖动率");
  });
});

describe("aggregateConfirmRuns：confirmed-pass 分支（优先级在 flaky-pass 之后）", () => {
  it("两遍单跑都未过 + 样本级确认达标 → confirmed-pass（passed=true）", () => {
    expect(
      aggregateConfirmRuns([{ passed: false }, { passed: false }], { sampleConfirmedPassed: true }),
    ).toEqual({ passKind: "confirmed-pass", passed: true });
  });

  it("复跑单跑全过仍记 flaky-pass（样本级确认不参与）；首跑过仍 first-pass", () => {
    expect(
      aggregateConfirmRuns([{ passed: false }, { passed: true }], { sampleConfirmedPassed: true }),
    ).toEqual({ passKind: "flaky-pass", passed: true });
    expect(aggregateConfirmRuns([{ passed: true }], { sampleConfirmedPassed: true })).toEqual({
      passKind: "first-pass",
      passed: true,
    });
  });

  it("两遍都未过且样本级确认未达标/未提供 → blocked（向后兼容）", () => {
    expect(
      aggregateConfirmRuns([{ passed: false }, { passed: false }], { sampleConfirmedPassed: false }),
    ).toEqual({ passKind: "blocked", passed: false });
    expect(aggregateConfirmRuns([{ passed: false }, { passed: false }])).toEqual({
      passKind: "blocked",
      passed: false,
    });
  });

  it("passKindLabel：confirmed-pass 文案醒目", () => {
    expect(passKindLabel("confirmed-pass")).toContain("确认放行");
  });
});

describe("formatRegressionReport：样本级确认与边界抖动区块", () => {
  const base = {
    suite: "followup" as const,
    versionLabel: "v3",
    mode: "live" as const,
    model: "deepseek-flash",
    generatedAt: new Date("2026-10-22T10:00:00Z"),
    thresholds: [
      { metric: "放水数（人审该追问但判跳过）", actual: "1", threshold: "≤ 0", passed: false },
    ],
    verdictPassed: true,
    sampleRows: ["| B5#1 | S2 | followup | 跳过 | miss | r1 |"],
    failures: [] as string[],
    confirmRuns: {
      passKind: "confirmed-pass" as const,
      runs: [
        {
          label: "首跑",
          thresholds: [
            { metric: "放水数（人审该追问但判跳过）", actual: "1", threshold: "≤ 0", passed: false },
          ],
          verdictPassed: false,
        },
        {
          label: "复跑1",
          thresholds: [
            { metric: "放水数（人审该追问但判跳过）", actual: "0", threshold: "≤ 0", passed: true },
          ],
          verdictPassed: false,
        },
      ],
    },
  };

  it("含「样本级确认判定」阈值行与「边界抖动清单」（各遍判定与理由摘要）", () => {
    const markdown = formatRegressionReport({
      ...base,
      sampleConfirm: {
        thresholdRows: [
          { metric: "确认放水数（两遍一致）", actual: "0", threshold: "≤ 0", passed: true },
          { metric: "确认误伤率（两遍一致）", actual: "0.0%", threshold: "≤ 20.0%", passed: true },
          { metric: "边界抖动率", actual: "3.2%", threshold: "≤ 15.0%", passed: true },
        ],
        confirmedLines: ["- B3#1（S3）：人审该追问，两遍均跳过（确认放水）"],
        flakyLines: ["- B5#1（S2）：人审该追问；首跑 跳过（理由A…）/ 复跑 追问（理由B…）"],
      },
    });
    expect(markdown).toContain("确认放行");
    expect(markdown).toContain("样本级确认判定");
    expect(markdown).toContain("确认放水数（两遍一致）");
    expect(markdown).toContain("边界抖动清单");
    expect(markdown).toContain("B5#1");
    expect(markdown).toContain("理由A");
  });

  it("sampleConfirm 缺省：不出现新区块（向后兼容）", () => {
    const markdown = formatRegressionReport(base);
    expect(markdown).not.toContain("样本级确认判定");
    expect(markdown).not.toContain("边界抖动清单");
  });
});
