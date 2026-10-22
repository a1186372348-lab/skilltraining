// prompt 变更回归门槛纯函数（T28 / D31 切片 2，BR-V2-7）：从既有校准分析结果提取门槛输入、
// 按阈值判定放行/阻断、格式化统一回归报告。
// 阈值默认值（首跑基线标定，均可经 CLI flag 覆盖）：
// - scoring：MAE ≤ 9.9（人审对齐平均绝对差，DeepSeek 基线 7.9 + 容差 2）、排序反转 ≤ 5 组、
//   每题 high-low 分离度 ≥ 20（沿用既有分离度口径的最小值版本）；
// - followup：放水数 ≤ 0（人审该追问但闸门判跳过，硬上限）、误伤率 ≤ 0.2（T35 R2 裁定线）。
// consistencyScore 落库口径（eval_runs）：scoring 存 MAE、followup 存放水数。

import type { CalibrationAnalysis, HumanAlignment } from "./eval-calibration.ts";
import type { GateComparison, GateHumanReview, GateSampleTask } from "./gate-calibration.ts";

/* ============================== 门槛输入与阈值 ============================== */

export interface ScoringGateMetrics {
  /** 人审对齐平均绝对差（meanAbsDiff）；人审数据缺失为 null */
  meanAbsDiff: number | null;
  /** 题内排序反转组数（pairStats.reversed，±3 噪声带内不计） */
  reversals: number;
  /** 各题 high-low 分离度（separationGap）的最小值；全部题不可比为 null */
  minSeparationGap: number | null;
}

export interface ScoringThresholds {
  maeMax: number;
  reversalsMax: number;
  minSeparation: number;
}

export interface FollowupGateMetrics {
  /** 放水数：人审该追问且机器判跳过 */
  missCount: number;
  /** 误伤率：人审不该追问且机器判追问 / 人审不该追问总数；人审无该分类样本为 null */
  harmRate: number | null;
}

export interface FollowupThresholds {
  missMax: number;
  harmRateMax: number;
}

export interface GateFailure {
  metric: string;
  actual: string;
  threshold: string;
}

export interface GateVerdict {
  passed: boolean;
  failures: GateFailure[];
}

/* ============================== 门槛输入提取 ============================== */

/** 从既有评分校准分析结果提取门槛输入（分离度取各题最小值——最弱题不过线即阻断） */
export function extractScoringGateMetrics(
  analysis: CalibrationAnalysis,
  human: HumanAlignment,
): ScoringGateMetrics {
  const gaps = analysis.questions
    .map((q) => q.separationGap)
    .filter((gap): gap is number => gap !== null);
  return {
    meanAbsDiff: human.meanAbsDiff,
    reversals: human.pairStats.reversed,
    minSeparationGap: gaps.length > 0 ? Math.min(...gaps) : null,
  };
}

/** 从闸门对照分析提取门槛输入 */
export function extractFollowupGateMetrics(comparison: GateComparison): FollowupGateMetrics {
  return {
    missCount: comparison.metrics.missCount,
    harmRate: comparison.metrics.harmRate,
  };
}

/* ============================== 门槛判定（等于阈值即放行） ============================== */

function fmtNum(value: number | null): string {
  return value === null ? "—" : String(Math.round(value * 100) / 100);
}

export function evaluateScoringGate(
  metrics: ScoringGateMetrics,
  thresholds: ScoringThresholds,
): GateVerdict {
  const failures: GateFailure[] = [];
  if (metrics.meanAbsDiff === null) {
    failures.push({ metric: "MAE（人审对齐平均绝对差）", actual: "数据缺失", threshold: `≤ ${thresholds.maeMax}` });
  } else if (metrics.meanAbsDiff > thresholds.maeMax) {
    failures.push({
      metric: "MAE（人审对齐平均绝对差）",
      actual: fmtNum(metrics.meanAbsDiff),
      threshold: `≤ ${thresholds.maeMax}`,
    });
  }
  if (metrics.reversals > thresholds.reversalsMax) {
    failures.push({
      metric: "排序反转组数",
      actual: String(metrics.reversals),
      threshold: `≤ ${thresholds.reversalsMax}`,
    });
  }
  if (metrics.minSeparationGap === null) {
    failures.push({ metric: "分离度（各题 high-low 最小分差）", actual: "无可比题", threshold: `≥ ${thresholds.minSeparation}` });
  } else if (metrics.minSeparationGap < thresholds.minSeparation) {
    failures.push({
      metric: "分离度（各题 high-low 最小分差）",
      actual: fmtNum(metrics.minSeparationGap),
      threshold: `≥ ${thresholds.minSeparation}`,
    });
  }
  return { passed: failures.length === 0, failures };
}

export function evaluateFollowupGate(
  metrics: FollowupGateMetrics,
  thresholds: FollowupThresholds,
): GateVerdict {
  const failures: GateFailure[] = [];
  if (metrics.missCount > thresholds.missMax) {
    failures.push({
      metric: "放水数（人审该追问但判跳过）",
      actual: String(metrics.missCount),
      threshold: `≤ ${thresholds.missMax}`,
    });
  }
  // harmRate 为 null = 人审无「不该追问」样本，误伤指标无可比证据，放行（报告注明）
  if (metrics.harmRate !== null && metrics.harmRate > thresholds.harmRateMax) {
    failures.push({
      metric: "误伤率（人审不该追问但判追问）",
      actual: `${(metrics.harmRate * 100).toFixed(1)}%`,
      threshold: `≤ ${(thresholds.harmRateMax * 100).toFixed(1)}%`,
    });
  }
  return { passed: failures.length === 0, failures };
}

/* ============================== 样本级双跑确认（切片 2 门禁补强，用户裁定） ============================== */

/**
 * 样本级确认判定（followup 套件专用，计数型指标）：
 * 计数型指标（放水/误伤）会被边界样本的单遍翻转穿透——两遍指标层都未过、
 * 逐样本看却没有一份两遍都错，属单遍抖动而非系统性退化。
 * 逐样本对齐两遍判定：
 * - 确认放水 = 人审 followup 且机器所有遍都 skip；
 * - 确认误伤 = 人审 skip 且机器所有遍都 followup；
 * - 边界抖动 = 遍间判定不一致（含灰区样本；某遍缺判定按抖动处理）——不计入失败，进抖动清单。
 */

/** 单遍单样本的机器判定（machine=null 表示该遍跑批失败、无判定） */
export interface RunSampleVerdict {
  machine: "followup" | "skip" | null;
  reason: string;
}

export type SampleConfirmKind = "agree" | "confirmed-miss" | "confirmed-harm" | "flaky" | "gray";

export interface SampleConfirmRow {
  label: string; // 如 B5#1
  blindId: string;
  human: "followup" | "skip" | "gray";
  kind: SampleConfirmKind;
  /** 各遍机器判定与理由（顺序同 runs） */
  runs: RunSampleVerdict[];
}

export interface SampleConfirmResult {
  rows: SampleConfirmRow[];
  totalCount: number;
  confirmedMissCount: number;
  confirmedHarmCount: number;
  humanFollowupCount: number;
  humanSkipCount: number;
  /** confirmedHarmCount / humanSkipCount；人审无 skip 样本为 null */
  confirmedHarmRate: number | null;
  flakyCount: number;
  /** flakyCount / totalCount（含灰区样本） */
  flakyRate: number;
}

export function confirmSampleRuns(input: {
  tasks: GateSampleTask[];
  human: GateHumanReview;
  /** 每遍：label（B5#1）→ 机器判定（缺 label = 该遍无判定） */
  runs: Map<string, { machine: "followup" | "skip"; reason: string }>[];
}): SampleConfirmResult {
  const rows: SampleConfirmRow[] = [];
  let confirmedMissCount = 0;
  let confirmedHarmCount = 0;
  let humanFollowupCount = 0;
  let humanSkipCount = 0;
  let flakyCount = 0;

  for (const task of input.tasks) {
    const label = `${task.questionId}#${task.sampleIndex}`;
    const human = input.human[task.questionId]?.[task.blindId];
    if (!human) continue; // 人审未覆盖（理论不可达：parseGateHumanReview 已全量校验）
    const runs: RunSampleVerdict[] = input.runs.map((run) => {
      const hit = run.get(label);
      return hit ?? { machine: null, reason: "（该遍跑批失败，无判定）" };
    });
    const allFollowup = runs.every((r) => r.machine === "followup");
    const allSkip = runs.every((r) => r.machine === "skip");
    const inconsistent = runs.some((r) => r.machine !== runs[0].machine);

    let kind: SampleConfirmKind;
    if (inconsistent) {
      kind = "flaky"; // 遍间判定不一致（含缺判定）——抖动，不计入失败
      flakyCount += 1;
    } else if (human === "gray") {
      kind = "gray";
    } else if (allFollowup && human === "skip") {
      kind = "confirmed-harm";
      confirmedHarmCount += 1;
    } else if (allSkip && human === "followup") {
      kind = "confirmed-miss";
      confirmedMissCount += 1;
    } else {
      kind = "agree";
    }
    if (human === "followup") humanFollowupCount += 1;
    if (human === "skip") humanSkipCount += 1;
    rows.push({ label, blindId: task.blindId, human, kind, runs });
  }

  const totalCount = rows.length;
  return {
    rows,
    totalCount,
    confirmedMissCount,
    confirmedHarmCount,
    humanFollowupCount,
    humanSkipCount,
    confirmedHarmRate: humanSkipCount > 0 ? confirmedHarmCount / humanSkipCount : null,
    flakyCount,
    flakyRate: totalCount > 0 ? flakyCount / totalCount : 0,
  };
}

/** 确认值门槛（followup 套件双跑时替代单遍计数门槛）：确认放水 =0、确认误伤率 ≤ 上限、抖动率 ≤ 上限 */
export interface FollowupSampleThresholds {
  missMax: number;
  harmRateMax: number;
  flakyRateMax: number;
}

export function evaluateFollowupSampleGate(
  result: SampleConfirmResult,
  thresholds: FollowupSampleThresholds,
): GateVerdict {
  const failures: GateFailure[] = [];
  if (result.confirmedMissCount > thresholds.missMax) {
    failures.push({
      metric: "确认放水数（所有遍一致判跳过）",
      actual: String(result.confirmedMissCount),
      threshold: `≤ ${thresholds.missMax}`,
    });
  }
  if (result.confirmedHarmRate !== null && result.confirmedHarmRate > thresholds.harmRateMax) {
    failures.push({
      metric: "确认误伤率（所有遍一致判追问）",
      actual: `${(result.confirmedHarmRate * 100).toFixed(1)}%`,
      threshold: `≤ ${(thresholds.harmRateMax * 100).toFixed(1)}%`,
    });
  }
  if (result.flakyRate > thresholds.flakyRateMax) {
    failures.push({
      metric: "边界抖动率（遍间判定不一致样本占比）",
      actual: `${(result.flakyRate * 100).toFixed(1)}%`,
      threshold: `≤ ${(thresholds.flakyRateMax * 100).toFixed(1)}%`,
    });
  }
  return { passed: failures.length === 0, failures };
}

/* ============================== 遍内定向补跑归并（切片 2 补充·选项 A） ============================== */

export interface SampleRunItem<T> {
  label: string;
  value: T;
}

export interface SampleRunFailureItem {
  label: string;
  /** 该次尝试的错误原因（首跑失败为初次原因；补跑后仍失败为补跑后原因） */
  error: string;
}

export interface SampleRetryMerge<T> {
  /** 初次成功 + 补跑成功（按 label 字典序，报告输出确定） */
  results: SampleRunItem<T>[];
  /** 初次失败、定向补跑成功（firstError 保留初次失败原因） */
  retriedSucceeded: { label: string; firstError: string }[];
  /** 补跑后仍失败（计入该遍「跑批失败样本数」） */
  failures: SampleRunFailureItem[];
}

/**
 * 遍内定向补跑归并（纯函数）：单遍全部样本跑完后，对失败样本做一次定向补跑
 * （脚本层等价于内部 --only 这些样本、写入该遍缓存）。
 * - retry 为 null：补跑被关闭（--no-sample-retry）或无失败样本——首跑结果原样透传；
 * - retry 非 null：补跑成功样本并入 results；初次失败原因保留在 retriedSucceeded；
 *   补跑仍失败的才进 failures。
 */
export function mergeSampleRetry<T>(
  first: { results: SampleRunItem<T>[]; failures: SampleRunFailureItem[] },
  retry: { results: SampleRunItem<T>[]; failures: SampleRunFailureItem[] } | null,
): SampleRetryMerge<T> {
  if (retry === null) {
    return {
      results: [...first.results].sort((a, b) => a.label.localeCompare(b.label)),
      retriedSucceeded: [],
      failures: first.failures,
    };
  }
  const retrySucceededLabels = new Set(retry.results.map((r) => r.label));
  const retriedSucceeded = first.failures
    .filter((f) => retrySucceededLabels.has(f.label))
    .map((f) => ({ label: f.label, firstError: f.error }));
  const results = [...first.results, ...retry.results].sort((a, b) => a.label.localeCompare(b.label));
  return { results, retriedSucceeded, failures: retry.failures };
}

/* ============================== 双跑确认制（切片 2 补充，用户裁定） ============================== */

/** 放行类型：一遍过 / 抖动放行（首跑未过、复跑单跑指标全过）/ 确认放行（两遍单跑未过但样本级确认达标且抖动率未超线）/ 双跑阻断 */
export type RegressionPassKind = "first-pass" | "flaky-pass" | "confirmed-pass" | "blocked";

export interface ConfirmRunOutcome {
  /** 该遍整体是否通过（门槛判定 && 无跑批失败样本） */
  passed: boolean;
}

/**
 * 双跑聚合判定（纯函数）——优先级：
 * 1. 首跑通过 → first-pass（调用方不得复跑；即便误传了复跑结果也以首跑为准）；
 * 2. 首跑未过、任一复跑单跑指标全过 → flaky-pass（抖动放行，退出码 0，报告醒目标注）；
 * 3. 各遍单跑皆未过，但样本级确认达标（确认放水/误伤未超线且抖动率未超线）
 *    → confirmed-pass（确认放行，退出码 0；仅 followup 套件双跑时提供 sampleConfirm）；
 * 4. 全部未过且无确认达标 → blocked（双跑阻断，退出码 1）。
 * 首跑未过且无复跑（--confirm-runs 1）→ blocked（与单跑行为一致）。
 */
export function aggregateConfirmRuns(
  runs: ConfirmRunOutcome[],
  options?: { sampleConfirmedPassed?: boolean },
): { passKind: RegressionPassKind; passed: boolean } {
  if (runs.length === 0) throw new Error("aggregateConfirmRuns 至少需要一遍结果");
  if (runs[0].passed) return { passKind: "first-pass", passed: true };
  const laterPass = runs.slice(1).some((run) => run.passed);
  if (laterPass) return { passKind: "flaky-pass", passed: true };
  if (runs.length >= 2 && options?.sampleConfirmedPassed === true) {
    return { passKind: "confirmed-pass", passed: true };
  }
  return { passKind: "blocked", passed: false };
}

/** 放行类型文案（报告醒目标注用） */
export function passKindLabel(passKind: RegressionPassKind): string {
  switch (passKind) {
    case "first-pass":
      return "一遍过（首跑全过，无需复跑）";
    case "flaky-pass":
      return "抖动放行（首跑未过、复跑单跑指标全过——判定为单跑抖动，建议关注该指标后续走势）";
    case "confirmed-pass":
      return "确认放行（两遍单跑指标未过，但样本级确认达标且边界抖动率未超线——无两遍一致的误判，判定为边界样本单遍抖动而非系统性退化）";
    case "blocked":
      return "双跑阻断（两遍皆未过且样本级确认未达标——判定为系统性退化，禁止上线）";
  }
}

/* ============================== 报告格式化 ============================== */

/** 门槛判定表行（指标 / 实际值 / 阈值 / 是否通过） */
export interface ThresholdRow {
  metric: string;
  actual: string;
  threshold: string;
  passed: boolean;
}

export interface RegressionReportParams {
  suite: "scoring" | "followup";
  /** 版本标识（v1 / v2 …；mock 模式为 "mock"，live 缺省为 "active"） */
  versionLabel: string;
  mode: "mock" | "live";
  model: string;
  generatedAt: Date;
  /** 门槛判定表行——单跑或双跑的首跑 */
  thresholds: ThresholdRow[];
  verdictPassed: boolean;
  /** 逐样本明细表行（markdown 表格行，由套件各自组装；首跑明细） */
  sampleRows: string[];
  /** 跑批失败样本清单（可读文案；首跑）——补跑后仍失败的部分 */
  failures: string[];
  /** 初次失败、定向补跑成功的样本（可读文案含初次失败原因；缺省 = 未启用或无此类样本，报告格式不变） */
  retriedSucceeded?: string[];
  /**
   * 双跑确认（存在时报告切换为并排格式：阈值表合并为 指标/阈值/首跑/复跑，
   * 结论标注三遍结果之一；缺省 = 单跑格式，向后兼容）
   */
  confirmRuns?: {
    passKind: RegressionPassKind;
    runs: {
      label: string;
      thresholds: ThresholdRow[];
      verdictPassed: boolean;
    }[];
  };
  /** 追加段落（如复跑逐样本明细） */
  extraSections?: { title: string; rows: string[] }[];
  /**
   * 样本级确认判定（followup 双跑，存在时新增两个区块：
   * 「样本级确认判定」阈值行 + 确认放水/误伤明细、「边界抖动清单」逐样本各遍判定与理由摘要）；
   * 缺省或单跑时不出现新区块（向后兼容）
   */
  sampleConfirm?: {
    thresholdRows: ThresholdRow[];
    confirmedLines: string[];
    flakyLines: string[];
  };
}

export function formatRegressionReport(params: RegressionReportParams): string {
  const lines: string[] = [
    `# prompt 回归报告：${params.suite}（T28 / D31，BR-V2-7）`,
    "",
    `- 版本：${params.versionLabel} ｜ 模式：${params.mode} ｜ 模型：${params.model} ｜ 时间：${params.generatedAt.toISOString()}`,
  ];

  if (params.confirmRuns) {
    // 双跑格式：三遍结论 + 并排阈值表
    lines.push(
      `- 门槛结论（双跑确认制）：**${passKindLabel(params.confirmRuns.passKind)}**`,
      "",
      "## 门槛判定（首跑 / 复跑并排）",
      "",
      `| 指标 | 阈值 | ${params.confirmRuns.runs.map((r) => r.label).join(" | ")} |`,
      `|---|---|${params.confirmRuns.runs.map(() => "---").join("|")}|`,
    );
    // 按指标名合并各跑结果（各跑指标集合一致——同套件同阈值）
    const firstRun = params.confirmRuns.runs[0];
    for (let i = 0; i < firstRun.thresholds.length; i += 1) {
      const row = firstRun.thresholds[i];
      const cells = params.confirmRuns.runs.map((run) => {
        const cell = run.thresholds[i];
        return `${cell.actual}（${cell.passed ? "✅" : "❌"}）`;
      });
      lines.push(`| ${row.metric} | ${row.threshold} | ${cells.join(" | ")} |`);
    }
  } else {
    // 单跑格式（向后兼容，--confirm-runs 1 时与旧版逐字一致）
    lines.push(
      `- 门槛结论：**${params.verdictPassed ? "通过（全部指标达标）" : "未通过（存在未达标指标，退出码 1）"}**`,
      "",
      "## 门槛判定",
      "",
      "| 指标 | 实际值 | 阈值 | 结果 |",
      "|---|---|---|---|",
      ...params.thresholds.map(
        (row) => `| ${row.metric} | ${row.actual} | ${row.threshold} | ${row.passed ? "✅ 达标" : "❌ 未达标"} |`,
      ),
    );
  }
  if (params.sampleRows.length > 0) {
    lines.push("", "## 逐样本明细", "", ...params.sampleRows);
  }
  for (const section of params.extraSections ?? []) {
    lines.push("", `## ${section.title}`, "", ...section.rows);
  }
  if (params.sampleConfirm) {
    // 样本级确认判定（确认放水/误伤 + 抖动率门槛）与边界抖动清单
    lines.push(
      "",
      "## 样本级确认判定（两遍一致的误判才计入失败）",
      "",
      "| 指标 | 实际值 | 阈值 | 结果 |",
      "|---|---|---|---|",
      ...params.sampleConfirm.thresholdRows.map(
        (row) => `| ${row.metric} | ${row.actual} | ${row.threshold} | ${row.passed ? "✅ 达标" : "❌ 未达标"} |`,
      ),
    );
    if (params.sampleConfirm.confirmedLines.length > 0) {
      lines.push("", "### 确认放水 / 确认误伤明细", "", ...params.sampleConfirm.confirmedLines);
    }
    if (params.sampleConfirm.flakyLines.length > 0) {
      lines.push("", "## 边界抖动清单（遍间判定不一致，不计入失败）", "", ...params.sampleConfirm.flakyLines);
    }
  }
  if (params.failures.length > 0 || (params.retriedSucceeded?.length ?? 0) > 0) {
    if (params.retriedSucceeded === undefined) {
      // 旧版单段格式（向后兼容）
      lines.push("", "## 失败样本（--only 定向补跑后重跑回归）", "", ...params.failures.map((f) => `- ${f}`));
    } else {
      // 两类区分：初次失败补跑成功（指标已并入）vs 补跑后仍失败（计入跑批失败样本数）
      lines.push("", "## 失败样本", "");
      if (params.retriedSucceeded.length > 0) {
        lines.push("", "### 初次失败、定向补跑成功（该遍指标已并入）", "", ...params.retriedSucceeded.map((f) => `- ${f}`));
      }
      if (params.failures.length > 0) {
        lines.push("", "### 补跑后仍失败（计入跑批失败样本数；可 --only 定向补跑后重跑回归）", "", ...params.failures.map((f) => `- ${f}`));
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
