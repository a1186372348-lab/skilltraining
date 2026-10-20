// 追问闸门人审校准纯函数（T35 / D37 步骤 5）：样本任务构造、人审判定文件解析、
// 机器判定与人审判定的对照分析、盲评材料与报告格式化。
// 供 scripts/eval-gate-samples.ts 调用；mock 与 live 数据共用同一条分析与报告管线。
//
// 指标口径（与产品负责人锁定）：
// - 放水（miss）：人审判定「该追问」（followup）且机器判定「跳过」（skip）——必须趋近 0；
// - 误伤（harm）：人审判定「不该追问」（skip）且机器判定「追问」（followup）——阈值由人审裁定；
// - 灰区（gray）：人审无法二值判定的样本，单独统计机器判定分布，
//   不进一致率分母，也不进放水/误伤两项率。

import type { FollowupGateResult, FollowupInput } from "../../server/ai/followup.ts";
import type { QuestionContent } from "../../server/modules/content/question-schema.ts";
import type { AnswerSample } from "../../server/modules/content/reference-answers.ts";

/* ============================== 样本任务 ============================== */

export interface GateSampleTask {
  questionId: string;
  questionTitle: string;
  /** 样本在 eval 文件中的序号（1 起） */
  sampleIndex: number;
  /** 人审盲评编号（baseline-8-human-review.json 的 sampleIndex ↔ blindId 映射） */
  blindId: string;
  /** 人审盲评总分（仅对照表上下文参考列，不参与闸门判定与指标） */
  humanScore: number;
  /** 闸门输入（主问题 + Rubric + 主测维度 + 首答） */
  input: FollowupInput;
}

/** 人审映射的最小契约（与 baseline-8-human-review.json 的 questions[qid] 同形） */
export interface GateReviewMapping {
  samples: { sampleIndex: number; blindId: string; humanScore: number }[];
}

/**
 * 构造单题样本任务：主测维度 = ability_tags[0]（与生产链路同一约定）；
 * sampleIndex ↔ blindId 映射不完整时直接报错（映射不全不可盲评）。
 */
export function buildGateSampleTasks(
  question: QuestionContent,
  answers: AnswerSample[],
  review: GateReviewMapping,
): GateSampleTask[] {
  const byIndex = new Map(review.samples.map((s) => [s.sampleIndex, s]));
  return answers.map((sample, index) => {
    const sampleIndex = index + 1;
    const mapping = byIndex.get(sampleIndex);
    if (!mapping) {
      throw new Error(
        `样本 ${question.id}#${sampleIndex} 在人审映射（baseline-8-human-review.json）中缺失，无法标注 blindId`,
      );
    }
    return {
      questionId: question.id,
      questionTitle: question.title,
      sampleIndex,
      blindId: mapping.blindId,
      humanScore: mapping.humanScore,
      input: {
        mainQuestion: question.main_question,
        firstAnswer: sample.text,
        rubric: question.rubric,
        primaryDimension: question.ability_tags[0],
      },
    };
  });
}

export function gateSampleLabel(task: GateSampleTask): string {
  return `${task.questionId}#${task.sampleIndex}`;
}

/* ============================== 机器判定结果 ============================== */

export interface GateMachineResult {
  task: GateSampleTask;
  shouldFollowup: boolean;
  /** 机器判定理由（中文一句话；仅审计与报告，不下发前端） */
  reason: string;
  followupCount: number;
  latencyMs: number;
  /** 实际调用次数（含重试） */
  attempts: number;
}

export interface GateSampleFailure {
  task: GateSampleTask;
  error: string;
  attempts: number;
}

/** 机器判定归一为二值（与人审 followup/skip 同词） */
function machineVerdict(result: GateMachineResult): "followup" | "skip" {
  return result.shouldFollowup ? "followup" : "skip";
}

/* ============================== 人审判定文件 ============================== */

export type GateHumanVerdict = "followup" | "skip" | "gray";
/** content/eval/gate-human-review.json 结构：题号 → blindId → 判定 */
export type GateHumanReview = Record<string, Record<string, GateHumanVerdict>>;

const VERDICT_VALUES: readonly GateHumanVerdict[] = ["followup", "skip", "gray"];

/**
 * 解析并校验人审判定文件（对照模式要求人审覆盖全部样本）：
 * - 非法 JSON / 非对象结构 / 非法判定值（值域 followup|skip|gray）→ 可读报错并指出位置；
 * - 未知题号 / 未知 blindId / 缺失样本判定 → 逐项列出，一次性报错。
 */
export function parseGateHumanReview(raw: string, tasks: GateSampleTask[]): GateHumanReview {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("人审判定文件不是合法 JSON（gate-human-review.json）");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("人审判定文件结构非法：应为 {题号: {blindId: 判定}} 的对象");
  }

  const byQuestion = new Map<string, GateSampleTask[]>();
  for (const task of tasks) {
    const list = byQuestion.get(task.questionId) ?? [];
    list.push(task);
    byQuestion.set(task.questionId, list);
  }

  const problems: string[] = [];
  const parsed: GateHumanReview = {};
  for (const [questionId, verdicts] of Object.entries(data as Record<string, unknown>)) {
    const questionTasks = byQuestion.get(questionId);
    if (!questionTasks) {
      problems.push(`未知题号：${questionId}（不在本次校准样本集中）`);
      continue;
    }
    if (typeof verdicts !== "object" || verdicts === null || Array.isArray(verdicts)) {
      problems.push(`题号 ${questionId} 的判定结构非法：应为 {blindId: 判定} 对象`);
      continue;
    }
    const knownBlindIds = new Set(questionTasks.map((t) => t.blindId));
    const questionParsed: Record<string, GateHumanVerdict> = {};
    for (const [blindId, verdict] of Object.entries(verdicts as Record<string, unknown>)) {
      if (!knownBlindIds.has(blindId)) {
        problems.push(`未知样本编号：${questionId} 的 ${blindId}（本题可选：${[...knownBlindIds].join("/")}）`);
        continue;
      }
      if (typeof verdict !== "string" || !VERDICT_VALUES.includes(verdict as GateHumanVerdict)) {
        problems.push(
          `非法判定值：${questionId} 的 ${blindId} = ${JSON.stringify(verdict)}（值域：${VERDICT_VALUES.join(" / ")}）`,
        );
        continue;
      }
      questionParsed[blindId] = verdict as GateHumanVerdict;
    }
    // 覆盖性校验：本题全部样本都必须有判定
    for (const task of questionTasks) {
      if (!(task.blindId in questionParsed)) {
        problems.push(`缺少判定：${questionId} 的 ${task.blindId}（样本 ${gateSampleLabel(task)}）——人审未覆盖全部样本`);
      }
    }
    parsed[questionId] = questionParsed;
  }
  if (problems.length > 0) {
    throw new Error(`人审判定文件校验失败：\n- ${problems.join("\n- ")}`);
  }
  return parsed;
}

/* ============================== 对照分析 ============================== */

export type GateComparisonOutcome = "agree" | "miss" | "harm" | "gray";

export interface GateComparisonRow {
  questionId: string;
  blindId: string;
  sampleIndex: number;
  human: GateHumanVerdict;
  machine: "followup" | "skip";
  /** agree=一致 / miss=放水 / harm=误伤 / gray=灰区 */
  outcome: GateComparisonOutcome;
  /** 机器判定理由 */
  reason: string;
  /** 人审总分（仅上下文参考，不参与判定） */
  humanScore: number;
}

export interface GateComparisonMetrics {
  /** 参与一致率的样本数（人审非灰区且有机器结果） */
  comparedCount: number;
  agreeCount: number;
  /** agreeCount / comparedCount；comparedCount=0 时为 null */
  agreeRate: number | null;
  /** 放水数：人审 followup 且机器 skip */
  missCount: number;
  humanFollowupCount: number;
  /** missCount / humanFollowupCount；人审无 followup 样本时为 null */
  missRate: number | null;
  /** 误伤数：人审 skip 且机器 followup */
  harmCount: number;
  humanSkipCount: number;
  /** harmCount / humanSkipCount；人审无 skip 样本时为 null */
  harmRate: number | null;
  grayCount: number;
  /** 灰区样本的机器判定分布 */
  grayMachineFollowup: number;
  grayMachineSkip: number;
  /** 全样本机器判定分布（含灰区） */
  machineFollowupCount: number;
  machineSkipCount: number;
}

export interface GateComparison {
  rows: GateComparisonRow[];
  metrics: GateComparisonMetrics;
  /** 人审已判定但机器结果缺失的样本（需 --only 定向补跑） */
  missingMachine: GateSampleTask[];
}

/** 对照分析：机器结果与人审判定逐样本比对；灰区不进一致率与放水/误伤两项率；
 * tasks 为样本全集（人审已覆盖但机器结果缺失的样本列入 missingMachine，提示 --only 补跑） */
export function analyzeGateComparison(input: {
  results: GateMachineResult[];
  human: GateHumanReview;
  tasks: GateSampleTask[];
}): GateComparison {
  const rows: GateComparisonRow[] = [];

  for (const result of input.results) {
    const verdict = input.human[result.task.questionId]?.[result.task.blindId];
    if (!verdict) continue; // 机器结果超出人审范围（如 --only 子集缓存合并且人审未含）——不强行对照
    const machine = machineVerdict(result);
    let outcome: GateComparisonOutcome;
    if (verdict === "gray") {
      outcome = "gray";
    } else if (verdict === machine) {
      outcome = "agree";
    } else if (verdict === "followup") {
      outcome = "miss"; // 放水：人审该追问、机器判跳过
    } else {
      outcome = "harm"; // 误伤：人审不该追问、机器判追问
    }
    rows.push({
      questionId: result.task.questionId,
      blindId: result.task.blindId,
      sampleIndex: result.task.sampleIndex,
      human: verdict,
      machine,
      outcome,
      reason: result.reason,
      humanScore: result.task.humanScore,
    });
  }

  // 人审覆盖但机器结果缺失的样本（按样本全集比对）：需 --only 定向补跑后重跑对照
  const resultKeys = new Set(input.results.map((r) => `${r.task.questionId}${r.task.blindId}`));
  const missingMachine = input.tasks.filter(
    (task) => input.human[task.questionId]?.[task.blindId] && !resultKeys.has(`${task.questionId}${task.blindId}`),
  );

  const metrics: GateComparisonMetrics = {
    comparedCount: 0,
    agreeCount: 0,
    agreeRate: null,
    missCount: 0,
    humanFollowupCount: 0,
    missRate: null,
    harmCount: 0,
    humanSkipCount: 0,
    harmRate: null,
    grayCount: 0,
    grayMachineFollowup: 0,
    grayMachineSkip: 0,
    machineFollowupCount: rows.filter((r) => r.machine === "followup").length,
    machineSkipCount: rows.filter((r) => r.machine === "skip").length,
  };
  for (const row of rows) {
    if (row.outcome === "gray") {
      metrics.grayCount += 1;
      if (row.machine === "followup") metrics.grayMachineFollowup += 1;
      else metrics.grayMachineSkip += 1;
      continue;
    }
    metrics.comparedCount += 1;
    if (row.outcome === "agree") metrics.agreeCount += 1;
    if (row.human === "followup") {
      metrics.humanFollowupCount += 1;
      if (row.outcome === "miss") metrics.missCount += 1;
    } else {
      metrics.humanSkipCount += 1;
      if (row.outcome === "harm") metrics.harmCount += 1;
    }
  }
  metrics.agreeRate = metrics.comparedCount > 0 ? metrics.agreeCount / metrics.comparedCount : null;
  metrics.missRate = metrics.humanFollowupCount > 0 ? metrics.missCount / metrics.humanFollowupCount : null;
  metrics.harmRate = metrics.humanSkipCount > 0 ? metrics.harmCount / metrics.humanSkipCount : null;

  return { rows, metrics, missingMachine };
}

/* ============================== 盲评材料 ============================== */

export interface BlindReviewQuestionGroup {
  questionId: string;
  mainQuestion: string;
  mainDimension: string;
  samples: { blindId: string; text: string }[];
}

/**
 * 生成盲评材料（盲评防线：绝不出现 quality / note / humanScore 等任何质量锚点，
 * 样本仅以 blindId 标注；评审指引写三值一词定义，建议逐题集中评审）。
 */
export function buildBlindReviewMarkdown(
  groups: BlindReviewQuestionGroup[],
  generatedAt: Date,
): string {
  const totalSamples = groups.reduce((acc, g) => acc + g.samples.length, 0);
  const lines: string[] = [
    "# 追问闸门盲评样本（T35 / D37 人审校准）",
    "",
    `> 生成时间：${generatedAt.toISOString()} ｜ 共 ${groups.length} 题 / ${totalSamples} 份样本`,
    "> 本材料仅供产品负责人盲评：样本已隐去一切质量标注，仅以编号（S1/S2/…）标识。",
    "",
    "## 评审指引",
    "",
    "请把自己当作该题主测维度的产品总监，对每份首答独立判定：**这份首答是否必须通过追问才能公允评分**。三值取一：",
    "",
    "- **该追问**：主测维度存在重大缺项或证据链缺口（核心主张无证据、关键假设未检验、明显逻辑漏洞或反方未回应）——不追问就会放过平庸答案；",
    "- **不该追问**：主测维度无重大缺项、证据链完整——追问没有增量价值，只是时间税；",
    "- **灰区**：介于两者之间，追问与否都说得通。",
    "",
    "建议**逐题集中评审**（同题样本连在一起看，但每份独立判定，不互相迁就）；可在判定后附一句话理由（可选）。",
    "判定结果请回填 `content/eval/gate-human-review.json`（结构：{题号: {编号: \"followup\"|\"skip\"|\"gray\"}}，followup=该追问 / skip=不该追问 / gray=灰区）。",
    "",
    "---",
  ];
  for (const group of groups) {
    lines.push("", `## ${group.questionId}（主测维度：${group.mainDimension}）`, "");
    lines.push(`**主问题**：${group.mainQuestion}`, "");
    for (const sample of group.samples) {
      lines.push(`### 样本 ${sample.blindId}`, "");
      lines.push(sample.text, "");
      lines.push("> **判定留白**：该追问 / 不该追问 / 灰区（圈选一个）；理由（可选）：______", "", "---");
    }
  }
  return `${lines.join("\n")}\n`;
}

/* ============================== 确定性桩（mock 模式，离线验证管线） ============================== */

export type GateRunner = (input: FollowupInput) => Promise<FollowupGateResult>;

function hashString(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** mock 闸门：同一输入恒定输出；约 2/3 样本判追问（两个分支都能走到），不调用任何外部服务 */
export function createMockGateRunner(tasks: GateSampleTask[]): GateRunner {
  const labelByInput = new Map<FollowupInput, string>(
    tasks.map((task) => [task.input, gateSampleLabel(task)]),
  );
  return async (input) => {
    const label = labelByInput.get(input) ?? "unknown";
    const shouldFollowup = hashString(`${label}|${input.firstAnswer}`) % 3 !== 0;
    return {
      shouldFollowup,
      reason: `mock 判定理由（${label}）`,
      followups: shouldFollowup
        ? [{ question: `mock 追问（${label}）`, hint: `mock 提示（${label}）` }]
        : [],
    };
  };
}

/* ============================== 报告格式化 ============================== */

export interface GateReportParams {
  /** mock=离线桩 / live=真实跑批 / compare=人审对照（机器结果来自缓存） */
  mode: "mock" | "live" | "compare";
  model: string;
  generatedAt: Date;
  results: GateMachineResult[];
  failures: GateSampleFailure[];
  /** 对照分析（compare 模式必填；机器模式为 null） */
  comparison: GateComparison | null;
}

function percent(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

const OUTCOME_LABELS: Record<GateComparisonOutcome, string> = {
  agree: "一致",
  miss: "放水",
  harm: "误伤",
  gray: "灰区",
};

const HUMAN_LABELS: Record<GateHumanVerdict, string> = {
  followup: "该追问",
  skip: "不该追问",
  gray: "灰区",
};

/** 控制台汇总：判定分布 + 失败清单（+ 对照核心指标） */
export function formatGateConsoleSummary(params: GateReportParams): string {
  const followupCount = params.results.filter((r) => r.shouldFollowup).length;
  const skipCount = params.results.length - followupCount;
  const lines = [
    `判定分布：追问 ${followupCount} / 跳过 ${skipCount}（共 ${params.results.length} 份，失败 ${params.failures.length} 份）`,
  ];
  for (const failure of params.failures) {
    lines.push(`- 失败 ${gateSampleLabel(failure.task)}：${failure.error}（${failure.attempts} 次尝试）`);
  }
  if (params.comparison) {
    const m = params.comparison.metrics;
    lines.push(
      `对照指标：一致率 ${percent(m.agreeRate)}（${m.agreeCount}/${m.comparedCount}）｜放水 ${m.missCount}（放水率 ${percent(m.missRate)}）｜误伤 ${m.harmCount}（误伤率 ${percent(m.harmRate)}）｜灰区 ${m.grayCount}（机器判追问 ${m.grayMachineFollowup} / 跳过 ${m.grayMachineSkip}）`,
    );
  }
  return lines.join("\n");
}

/** Markdown 报告：机器模式（分布 + 逐样本表 + 失败清单）或对照模式（追加人审对照段与结论区） */
export function formatGateMarkdownReport(params: GateReportParams): string {
  const followupCount = params.results.filter((r) => r.shouldFollowup).length;
  const skipCount = params.results.length - followupCount;
  const modeLabel =
    params.mode === "compare" ? "人审对照" : params.mode === "live" ? "真实跑批" : "mock 离线验证";
  const lines: string[] = [
    "# 追问闸门校准报告（T35 / D37）",
    "",
    `- 模式：${modeLabel} ｜ 模型：${params.model} ｜ 生成时间：${params.generatedAt.toISOString()}`,
    `- 样本：${params.results.length} 份成功 / ${params.failures.length} 份失败`,
    "",
    "## 一、机器判定分布",
    "",
    `**追问 ${followupCount} / 跳过 ${skipCount}**（共 ${params.results.length} 份）`,
    "",
    "| 样本 | blindId | 判定 | 追问轮数 | 机器 reason | 耗时 | 尝试 |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const result of params.results) {
    lines.push(
      `| ${gateSampleLabel(result.task)} | ${result.task.blindId} | ${result.shouldFollowup ? "追问" : "跳过"} | ${result.followupCount} | ${escapeCell(result.reason)} | ${(result.latencyMs / 1000).toFixed(1)}s | ${result.attempts} |`,
    );
  }
  if (params.failures.length > 0) {
    lines.push("", "### 失败样本（可用 --only 定向补跑）", "");
    for (const failure of params.failures) {
      lines.push(`- ${gateSampleLabel(failure.task)}（${failure.task.blindId}）：${failure.error}`);
    }
  }

  if (params.comparison) {
    const { rows, metrics, missingMachine } = params.comparison;
    lines.push(
      "",
      "## 二、人审对照",
      "",
      "> 判定口径：**放水** = 人审该追问 且 机器判跳过（须趋近 0）；**误伤** = 人审不该追问 且 机器判追问（阈值人审裁定）；**灰区**单独统计，不进一致率与两项率。",
      "> humanScore（人审总分）仅为上下文参考列，不参与判定与指标。",
      "",
      "| 样本 | blindId | 人审判定 | 机器判定 | 结论 | 机器 reason | humanScore* |",
      "|---|---|---|---|---|---|---|",
    );
    for (const row of rows) {
      lines.push(
        `| ${row.questionId}#${row.sampleIndex} | ${row.blindId} | ${HUMAN_LABELS[row.human]} | ${row.machine === "followup" ? "追问" : "跳过"} | ${OUTCOME_LABELS[row.outcome]} | ${escapeCell(row.reason)} | ${row.humanScore} |`,
      );
    }
    lines.push(
      "",
      "### 指标",
      "",
      `- **一致率**：${percent(metrics.agreeRate)}（${metrics.agreeCount}/${metrics.comparedCount}，灰区不进分母）`,
      `- **放水**：${metrics.missCount} 份，放水率 ${percent(metrics.missRate)}（${metrics.missCount}/${metrics.humanFollowupCount}，分母 = 人审该追问样本数）`,
      `- **误伤**：${metrics.harmCount} 份，误伤率 ${percent(metrics.harmRate)}（${metrics.harmCount}/${metrics.humanSkipCount}，分母 = 人审不该追问样本数）`,
      `- **灰区**：${metrics.grayCount} 份——机器判追问 ${metrics.grayMachineFollowup} / 判跳过 ${metrics.grayMachineSkip}`,
      "",
      "## 三、结论",
      "",
      `- 放水达标线（= 0 或趋近 0）：${metrics.missCount === 0 ? "**达标**（放水 = 0）" : `**未达标**（放水 ${metrics.missCount} 份，需复核判定 prompt 从紧表述或样本标注）`}`,
      `- 误伤率阈值：留空，待主代理与人审裁定后填写（当前误伤率 ${percent(metrics.harmRate)}）。`,
      `- 灰区样本的机器判定分布供阈值调优参考（喂给 T28 调优体系）。`,
    );
    if (missingMachine.length > 0) {
      lines.push(
        "",
        "### 机器结果缺失（--only 定向补跑后重跑对照）",
        "",
        ...missingMachine.map((task) => `- ${gateSampleLabel(task)}（${task.blindId}）`),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
