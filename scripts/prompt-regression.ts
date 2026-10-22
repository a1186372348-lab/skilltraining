// prompt 变更统一回归门槛（T28 / D31 切片 2，BR-V2-7）：一个命令对指定 prompt 版本跑
// 全量回归、按门槛判定、写 eval_runs 留档、不过门槛退出码 1。
// 用法：
//   node scripts/prompt-regression.ts --suite scoring|followup
//     mock 模式（默认）：确定性桩（零 AI 出网），离线验证管线；门槛判定照常执行但
//     桩数据无业务含义；不写 eval_runs，报告仅打印（--out 时才落盘）
//   node --env-file=.env scripts/prompt-regression.ts --suite scoring --live --cache .cache/reg-scoring.jsonl
//     live 模式：真实调用 DeepSeek（密钥仅经环境变量注入，不打印不落盘；产生 token 消耗），
//     串行执行，单样本失败重试 2 次后记录跳过；门槛判定 + 报告写入
//     docs/v2/regression/<suite>-<version>-<yyyymmdd-hhmmss>.md + eval_runs 留档
//   可选：--version vN   回归指定版本（缺省回归 DB 中该 suite 的 active 版本；
//                        live 模式用该版本 content 作为 prompt 模板跑批）
//   可选：--only B5#2    定向补跑（子集汇总不代表整批结论）
//   可选：--out <路径>   覆盖报告输出位置
//   可选（scoring 门槛，默认基线标定值）：--mae-max 9.9 --reversals-max 5 --min-separation 20
//   可选（followup 门槛，T35 R2 校准裁定线）：--miss-max 0 --harm-rate-max 0.2
//   可选：--confirm-runs <n>  双跑确认制（默认 2）：首跑未过（任一指标不达标或失败样本 >0）时
//         自动用全新缓存（<cache>.retry1.jsonl，不污染首跑缓存）复跑整个套件；
//         首跑全过不复跑；n=1 退回原单跑行为（报告格式逐字兼容）
//   可选：--no-sample-retry  关闭遍内定向补跑（默认开启）：每一遍（首跑与每次复跑）内部，
//         全部样本跑完后对失败样本做一次定向补跑（等价于内部 --only，写入该遍缓存，
//         不污染其他遍）；补跑成功样本并入该遍指标，补跑仍失败才计入「跑批失败样本数」；
//         与双跑确认制关系不变：补跑后该遍的门槛判定结果才决定是否进入下一遍复跑
//   可选：--max-flaky-rate <r>  边界抖动率上限（默认 0.15；仅 followup 双跑样本级确认生效）：
//         逐样本对齐两遍判定——两遍一致才计确认放水/确认误伤；遍间不一致进「边界抖动清单」
//         不计入失败，但抖动样本占比超线同样阻断（确定性的量化问责）
// 判定口径：
//   - scoring：MAE（人审对齐平均绝对差）≤ maeMax；题内排序反转 ≤ reversalsMax 组；
//     各题 high-low 分离度最小值 ≥ minSeparation；
//   - followup：放水数 ≤ missMax（硬上限 0）；误伤率 ≤ harmRateMax；
//   - 任一样本跑批失败同样阻断（门槛数据不完整不得放行）；
//   - 等于阈值即放行；结论四态：一遍过 / 抖动放行（首跑未过、复跑单跑指标全过）/ 确认放行（两遍单跑未过，
//     但样本级确认达标且抖动率未超线，followup 专用）/ 双跑阻断（退出码 1，其余退出码 0）；
//   - 注意：mock 桩为确定性输出，mock 模式下复跑结果与首跑恒一致（双跑仅验证管线，无业务含义）。
// eval_runs 留档口径：每次调用一行；consistencyScore = 放行所依据那遍的主指标
// （scoring 存 MAE、followup 存放水数；first-pass 取首跑、flaky-pass 取复跑）；
// report JSON 记录 passKind（first-pass / flaky-pass / blocked）与各遍指标全文。
// 退出码：加载/校验/版本解析失败 → 1；双跑阻断 → 1；一遍过/抖动放行 → 0。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { AI_MODEL, createAiClientFromEnv } from "../server/ai/client.ts";
import {
  buildFollowupMessages,
  parseFollowupGateOutput,
} from "../server/ai/followup.ts";
import { parsePromptContent } from "../server/ai/prompts/registry.ts";
import {
  findActivePromptVersion,
  insertEvalRun,
} from "../server/ai/prompts/repository.ts";
import type { PromptTemplatePair } from "../server/ai/prompts/template.ts";
import { prisma } from "../server/lib/prisma.ts";
import { scoreWithRubric } from "../server/modules/scoring/rubric-scorer.ts";
import {
  analyzeHumanAlignment,
  analyzeScores,
  createMockEvalScorer,
  overallScore,
  sampleLabel,
  type EvalSampleTask,
  type EvalScorer,
  type HumanReviewData,
  type SampleScore,
} from "./lib/eval-calibration.ts";
import {
  HUMAN_REVIEW_PATH,
  loadBaselineSampleSet,
  loadGateHumanReviewFile,
  loadGateSampleSet,
} from "./lib/eval-sample-loaders.ts";
import {
  analyzeGateComparison,
  createMockGateRunner,
  gateSampleLabel,
  type GateHumanReview,
  type GateMachineResult,
  type GateRunner,
  type GateSampleTask,
} from "./lib/gate-calibration.ts";
import {
  aggregateConfirmRuns,
  confirmSampleRuns,
  evaluateFollowupGate,
  evaluateFollowupSampleGate,
  evaluateScoringGate,
  extractFollowupGateMetrics,
  extractScoringGateMetrics,
  formatRegressionReport,
  passKindLabel,
  type FollowupGateMetrics,
  type FollowupThresholds,
  type GateVerdict,
  type SampleConfirmResult,
  type ScoringGateMetrics,
  type ScoringThresholds,
  type ThresholdRow,
} from "./lib/regression-gate.ts";
import {
  runSerialWithSampleRetry,
  type JsonlCache,
} from "./lib/serial-runner.ts";

const SUITE_PROMPT_NAME: Record<Suite, string> = { scoring: "scoring", followup: "followup" };
type Suite = "scoring" | "followup";

/* ============================== 参数解析 ============================== */

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value) {
    console.error(`${flag} 需要跟一个参数值`);
    process.exit(1);
  }
  return value;
}

function numArg(flag: string, fallback: number): number {
  const raw = argValue(flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.error(`${flag} 需要数字参数（收到 ${raw}）`);
    process.exit(1);
  }
  return value;
}

const suiteArg = argValue("--suite") as Suite | undefined;
if (!suiteArg || !["scoring", "followup"].includes(suiteArg)) {
  console.error("用法：node scripts/prompt-regression.ts --suite scoring|followup [--version vN] [--live --cache <路径>] [--out <路径>] [--only 标签] [门槛 flags]");
  process.exit(1);
}
const suite: Suite = suiteArg;
const live = process.argv.includes("--live");
const versionArg = argValue("--version");
const outPath = argValue("--out");
const cacheArg = argValue("--cache");
const onlyArg = argValue("--only");
const onlyFilter = onlyArg
  ? onlyArg.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  : null;
if (onlyArg !== undefined && (!onlyFilter || onlyFilter.length === 0)) {
  console.error("--only 需要跟逗号分隔的样本标签（如 B5#2,B7#1）");
  process.exit(1);
}
const scoringThresholds: ScoringThresholds = {
  maeMax: numArg("--mae-max", 9.9),
  reversalsMax: numArg("--reversals-max", 5),
  minSeparation: numArg("--min-separation", 20),
};
const followupThresholds: FollowupThresholds = {
  missMax: numArg("--miss-max", 0),
  harmRateMax: numArg("--harm-rate-max", 0.2),
};
// 边界抖动率上限（样本级双跑确认，followup 专用；默认 0.15）
const flakyRateMax = numArg("--max-flaky-rate", 0.15);
// 双跑确认制（默认 2 遍）：首跑未过自动用全新缓存复跑；1 = 退回原单跑行为
const confirmRuns = Math.floor(numArg("--confirm-runs", 2));
if (!Number.isFinite(confirmRuns) || confirmRuns < 1) {
  console.error("--confirm-runs 需要 ≥ 1 的整数");
  process.exit(1);
}
// 遍内定向补跑（默认开启）：每一遍内部对失败样本做一次定向补跑；--no-sample-retry 关闭
const sampleRetry = !process.argv.includes("--no-sample-retry");

/** 复跑缓存路径：<cache>.retry1.jsonl（全新文件，不读不写首跑缓存） */
function retryCachePath(cacheFile: string, round: number): string {
  return `${cacheFile.replace(/\.jsonl$/i, "")}.retry${round}.jsonl`;
}

/* ============================== 断点缓存（JSONL 逐行追加，命中即跳过；编排内核见 scripts/lib/serial-runner.ts） ============================== */

function loadJsonlCache<T extends { label: string; attempts: number }>(file: string, validate: (raw: unknown) => raw is T): JsonlCache<T> {
  const entries = new Map<string, T>();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as unknown;
        if (validate(entry)) entries.set(entry.label, entry);
      } catch {
        console.error(`缓存行解析失败，已忽略：${trimmed.slice(0, 60)}…`);
      }
    }
  }
  mkdirSync(path.dirname(file), { recursive: true });
  return { path: file, entries };
}

function appendCache<T extends { label: string; attempts: number }>(cache: JsonlCache<T>, entry: T): void {
  appendFileSync(cache.path, `${JSON.stringify(entry)}\n`, "utf8");
  cache.entries.set(entry.label, entry);
}

/* ============================== 版本解析（live：回归目标版本的 prompt 模板） ============================== */

interface ResolvedVersion {
  id: string;
  version: string;
  templates: PromptTemplatePair;
}

async function resolveRegressionVersion(name: string): Promise<ResolvedVersion> {
  const row = versionArg
    ? await prisma.promptVersion.findUnique({ where: { name_version: { name, version: versionArg } } })
    : await findActivePromptVersion(prisma, name);
  if (!row) {
    throw new Error(
      `未找到 prompt 版本行（${name} ${versionArg ?? "active"}）——先经 scripts/prompt-register.ts 登记/激活`,
    );
  }
  const templates = parsePromptContent(row.content);
  if (!templates) {
    throw new Error(`prompt 版本 ${name}/${row.version} 的 content 非法（非 JSON canonical），请重新登记`);
  }
  return { id: row.id, version: row.version, templates };
}


/* ============================== scoring 套件 ============================== */

interface ScoringCacheEntry {
  label: string;
  output: SampleScore["output"];
  overall: number;
  attempts: number;
}

function isScoringCacheEntry(raw: unknown): raw is ScoringCacheEntry {
  const entry = raw as ScoringCacheEntry;
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof entry.label === "string" &&
    typeof entry.overall === "number" &&
    typeof entry.output === "object"
  );
}

/** 单遍跑批结果（双跑确认制的每遍产出） */
interface SuiteRunOutcome<TMetrics> {
  /** 该遍整体通过 = 门槛全过 且 无跑批失败样本（补跑后仍失败才计入） */
  passed: boolean;
  metrics: TMetrics;
  verdict: GateVerdict;
  thresholdRows: ThresholdRow[];
  sampleRows: string[];
  failureLines: string[];
  /** 初次失败、定向补跑成功的样本（可读文案含初次失败原因；指标已并入） */
  retriedSucceededLines: string[];
  /** 供 eval_runs 留档的套件自有数据（scoring：analysis/humanAlignment；followup：comparison） */
  artifacts: Record<string, unknown>;
}


async function executeScoringRun(
  tasks: EvalSampleTask[],
  humanReview: HumanReviewData,
  scorer: EvalScorer,
  cache?: JsonlCache<ScoringCacheEntry>,
): Promise<SuiteRunOutcome<ScoringGateMetrics>> {
  const { merged } = await runSerialWithSampleRetry<EvalSampleTask, SampleScore["output"], ScoringCacheEntry>(
    {
      labelOf: sampleLabel,
      run: async (task) => {
        const output = await scorer(task.input);
        return { result: output, entry: { output, overall: overallScore(output) } };
      },
      fromCache: (_task, entry) => entry.output,
      cache,
      validate: isScoringCacheEntry,
      logLine: (task, _result, _attempts, cached) => `${sampleLabel(task)}（${task.quality}）${cached ? "（缓存命中）" : ""}`,
      appendCacheEntry: appendCache,
    },
    tasks,
    sampleRetry,
  );
  const scores: SampleScore[] = merged.results.map((r) => ({
    task: r.value.task,
    output: r.value.result,
    overall: overallScore(r.value.result),
    attempts: r.value.attempts,
  }));

  const analysis = analyzeScores(scores);
  const humanAlignment = analyzeHumanAlignment(scores, humanReview);
  const metrics = extractScoringGateMetrics(analysis, humanAlignment);
  const verdict: GateVerdict = evaluateScoringGate(metrics, scoringThresholds);
  const failures = merged.failures;
  const passed = verdict.passed && failures.length === 0;

  const thresholdRows: ThresholdRow[] = [
    { metric: "MAE（人审对齐平均绝对差）", actual: metrics.meanAbsDiff === null ? "数据缺失" : metrics.meanAbsDiff.toFixed(1), threshold: `≤ ${scoringThresholds.maeMax}`, passed: metrics.meanAbsDiff !== null && metrics.meanAbsDiff <= scoringThresholds.maeMax },
    { metric: "排序反转组数", actual: String(metrics.reversals), threshold: `≤ ${scoringThresholds.reversalsMax}`, passed: metrics.reversals <= scoringThresholds.reversalsMax },
    { metric: "分离度（各题 high-low 最小分差）", actual: metrics.minSeparationGap === null ? "无可比题" : metrics.minSeparationGap.toFixed(1), threshold: `≥ ${scoringThresholds.minSeparation}`, passed: metrics.minSeparationGap !== null && metrics.minSeparationGap >= scoringThresholds.minSeparation },
    { metric: "跑批失败样本数", actual: String(failures.length), threshold: "= 0", passed: failures.length === 0 },
  ];
  const sampleRows = [
    "| 样本 | blindId | 质量档 | 人审总分 | 机器主测分 | 差值 |",
    "|---|---|---|---|---|---|",
    ...humanAlignment.rows.map(
      (row) =>
        `| ${row.label} | ${row.blindId} | ${row.quality} | ${row.humanScore} | ${row.machineMain ?? "—"} | ${row.diff === null ? "—" : row.diff.toFixed(1)} |`,
    ),
  ];
  return {
    passed,
    metrics,
    verdict,
    thresholdRows,
    sampleRows,
    failureLines: failures.map((f) => `${f.label}：${f.error}`),
    retriedSucceededLines: merged.retriedSucceeded.map(
      (r) => `${r.label}：${r.firstError}（初次失败，定向补跑成功）`,
    ),
    artifacts: { analysis, humanAlignment },
  };
}

/** 单遍结论控制台输出（两遍同一格式） */
function printRunSummary<TMetrics>(label: string, run: SuiteRunOutcome<TMetrics>): void {
  const m = run.metrics as ScoringGateMetrics | FollowupGateMetrics;
  const detail =
    "meanAbsDiff" in m
      ? `MAE ${m.meanAbsDiff?.toFixed(1) ?? "—"} / 反转 ${m.reversals} / 分离度 ${m.minSeparationGap?.toFixed(1) ?? "—"}`
      : `放水 ${m.missCount} / 误伤率 ${m.harmRate === null ? "—" : `${(m.harmRate * 100).toFixed(1)}%`}`;
  const retriedNote =
    run.retriedSucceededLines.length > 0
      ? `（另 ${run.retriedSucceededLines.length} 份初次失败、定向补跑成功，已并入指标）`
      : "";
  console.log(`\n${label}门槛结论：${run.passed ? "✅ 通过" : "❌ 未通过"}（${detail} / 失败样本 ${run.failureLines.length}）${retriedNote}`);
  for (const failure of run.verdict.failures) {
    console.log(`- 未达标：${failure.metric} 实际 ${failure.actual}（阈值 ${failure.threshold}）`);
  }
}

/** 双跑确认驱动：首跑未过且 confirmRuns ≥ 2 时用全新缓存复跑（至多 confirmRuns 遍，通过即停） */
async function runWithConfirmation<TMetrics>(input: {
  runOnce: (cache?: JsonlCache<never>) => Promise<SuiteRunOutcome<TMetrics>>;
  newCache: (round: number) => JsonlCache<never> | undefined;
}): Promise<SuiteRunOutcome<TMetrics>[]> {
  const runs: SuiteRunOutcome<TMetrics>[] = [];
  const first = await input.runOnce(input.newCache(0));
  runs.push(first);
  // --confirm-runs 1 退回原单跑行为：控制台结论不带「首跑」前缀（与旧版一致）
  printRunSummary(confirmRuns >= 2 ? "首跑" : "本次", first);
  for (let round = 1; round < confirmRuns && !runs[runs.length - 1].passed; round += 1) {
    const retryFile = cacheArg ? retryCachePath(path.resolve(cacheArg), round) : null;
    console.log(
      `\n双跑确认制：首跑未过，第 ${round + 1} 遍复跑（${retryFile ? `全新缓存 ${retryFile}，` : ""}不读不写首跑缓存）…`,
    );
    const rerun = await input.runOnce(input.newCache(round));
    runs.push(rerun);
    printRunSummary(`复跑${round}`, rerun);
  }
  return runs;
}

async function runScoringSuite(): Promise<{ exitCode: number }> {
  const { tasks: allTasks, humanReview } = loadBaselineSampleSet();
  if (!humanReview) {
    throw new Error(`回归门槛需要人审对齐数据：${HUMAN_REVIEW_PATH} 缺失`);
  }
  let tasks = allTasks;
  if (onlyFilter) {
    const all = allTasks.map(sampleLabel);
    const unknown = onlyFilter.filter((label) => !all.includes(label));
    if (unknown.length > 0) throw new Error(`--only 包含未知样本标签：${unknown.join(", ")}`);
    tasks = allTasks.filter((task) => onlyFilter.includes(sampleLabel(task)));
  }

  const version = live ? await resolveRegressionVersion(SUITE_PROMPT_NAME.scoring) : null;
  const versionLabel = live ? version!.version : (versionArg ?? "mock");
  const scorer: EvalScorer = live
    ? (input) => scoreWithRubric(input, { templates: version!.templates })
    : createMockEvalScorer(tasks);

  console.log(
    `回归套件 scoring（${live ? "live" : "mock"}，版本 ${versionLabel}，双跑确认 ${confirmRuns} 遍）：${tasks.length} 份样本串行评分中…${live ? "（真实调用 DeepSeek，产生 token 消耗）" : ""}`,
  );
  const runs = await runWithConfirmation<ScoringGateMetrics>({
    runOnce: (cache) => executeScoringRun(tasks, humanReview, scorer, cache as JsonlCache<ScoringCacheEntry> | undefined),
    newCache: (round) =>
      cacheArg
        ? (loadJsonlCache(
            round === 0 ? path.resolve(cacheArg) : retryCachePath(path.resolve(cacheArg), round),
            isScoringCacheEntry,
          ) as never)
        : undefined,
  });
  const aggregate = aggregateConfirmRuns(runs.map((r) => ({ passed: r.passed })));
  const first = runs[0];
  const confirming = aggregate.passKind === "flaky-pass" ? runs[runs.length - 1] : first;

  const reportParams = {
    suite: "scoring" as const,
    versionLabel,
    mode: live ? ("live" as const) : ("mock" as const),
    model: live ? AI_MODEL : "mock",
    generatedAt: new Date(),
    thresholds: first.thresholdRows,
    verdictPassed: aggregate.passed,
    sampleRows: first.sampleRows,
    failures: first.failureLines,
    retriedSucceeded: first.retriedSucceededLines,
    confirmRuns:
      confirmRuns >= 2
        ? {
            passKind: aggregate.passKind,
            runs: runs.map((run, index) => ({
              label: index === 0 ? "首跑" : `复跑${index}`,
              thresholds: run.thresholdRows,
              verdictPassed: run.passed,
            })),
          }
        : undefined,
    extraSections:
      runs.length > 1
        ? [{ title: "复跑逐样本明细", rows: runs[runs.length - 1].sampleRows }]
        : undefined,
  };
  const report = formatRegressionReport(reportParams);
  if (confirmRuns >= 2) {
    console.log(`\n双跑结论：${passKindLabel(aggregate.passKind)}`);
  }

  await persistRun({
    suite: "scoring",
    version,
    versionLabel,
    report,
    reportParams,
    consistencyScore: confirming.metrics.meanAbsDiff,
    extra: {
      passKind: aggregate.passKind,
      runs: runs.map((run, index) => ({
        label: index === 0 ? "first" : `retry${index}`,
        metrics: run.metrics,
        verdictPassed: run.passed,
        failures: run.failureLines,
      })),
      ...first.artifacts,
    },
  });
  return { exitCode: aggregate.passed ? 0 : 1 };
}

/* ============================== followup 套件 ============================== */

interface FollowupCacheEntry {
  label: string;
  shouldFollowup: boolean;
  reason: string;
  followupCount: number;
  latencyMs: number;
  attempts: number;
}

/** followup 套件单份样本的跑批结果（机器判定） */
interface FollowupRunResult {
  shouldFollowup: boolean;
  reason: string;
  followupCount: number;
  latencyMs: number;
}

function isFollowupCacheEntry(raw: unknown): raw is FollowupCacheEntry {
  const entry = raw as FollowupCacheEntry;
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof entry.label === "string" &&
    typeof entry.shouldFollowup === "boolean"
  );
}

async function executeFollowupRun(
  tasks: GateSampleTask[],
  human: GateHumanReview,
  runner: GateRunner,
  cache?: JsonlCache<FollowupCacheEntry>,
): Promise<SuiteRunOutcome<FollowupGateMetrics>> {
  const { merged } = await runSerialWithSampleRetry<GateSampleTask, FollowupRunResult, FollowupCacheEntry>(
    {
      labelOf: gateSampleLabel,
      run: async (task) => {
        const startedAt = Date.now();
        const gate = await runner(task.input);
        const latencyMs = Date.now() - startedAt;
        return {
          result: {
            shouldFollowup: gate.shouldFollowup,
            reason: gate.reason,
            followupCount: gate.followups.length,
            latencyMs,
          },
          entry: {
            shouldFollowup: gate.shouldFollowup,
            reason: gate.reason,
            followupCount: gate.followups.length,
            latencyMs,
          },
        };
      },
      fromCache: (_task, entry) => ({
        shouldFollowup: entry.shouldFollowup,
        reason: entry.reason,
        followupCount: entry.followupCount,
        latencyMs: entry.latencyMs,
      }),
      cache,
      validate: isFollowupCacheEntry,
      logLine: (task, result, _attempts, cached) =>
        `${gateSampleLabel(task)}（${task.blindId}）${result.shouldFollowup ? "追问" : "跳过"}${cached ? "（缓存命中）" : ""}`,
      appendCacheEntry: appendCache,
    },
    tasks,
    sampleRetry,
  );
  const machineResults: GateMachineResult[] = merged.results.map((r) => ({
    task: r.value.task,
    shouldFollowup: r.value.result.shouldFollowup,
    reason: r.value.result.reason,
    followupCount: r.value.result.followupCount,
    latencyMs: r.value.result.latencyMs,
    attempts: r.value.attempts,
  }));

  const comparison = analyzeGateComparison({ results: machineResults, human, tasks });
  // 逐样本判定映射（样本级双跑确认对齐用；纯对象形态可直接进 eval_runs JSON）
  const verdictMap: Record<string, { machine: "followup" | "skip"; reason: string }> = {};
  for (const row of comparison.rows) {
    verdictMap[`${row.questionId}#${row.sampleIndex}`] = { machine: row.machine, reason: row.reason };
  }
  const metrics = extractFollowupGateMetrics(comparison);
  const verdict: GateVerdict = evaluateFollowupGate(metrics, followupThresholds);
  const failures = merged.failures;
  const passed = verdict.passed && failures.length === 0;

  const thresholdRows: ThresholdRow[] = [
    { metric: "放水数（人审该追问但判跳过）", actual: String(metrics.missCount), threshold: `≤ ${followupThresholds.missMax}`, passed: metrics.missCount <= followupThresholds.missMax },
    { metric: "误伤率（人审不该追问但判追问）", actual: metrics.harmRate === null ? "无可比样本" : `${(metrics.harmRate * 100).toFixed(1)}%`, threshold: `≤ ${(followupThresholds.harmRateMax * 100).toFixed(1)}%`, passed: metrics.harmRate === null || metrics.harmRate <= followupThresholds.harmRateMax },
    { metric: "跑批失败样本数", actual: String(failures.length), threshold: "= 0", passed: failures.length === 0 },
  ];
  const sampleRows = [
    "| 样本 | blindId | 人审判定 | 机器判定 | 结论 | 机器 reason |",
    "|---|---|---|---|---|---|",
    ...comparison.rows.map(
      (row) =>
        `| ${row.questionId}#${row.sampleIndex} | ${row.blindId} | ${row.human} | ${row.machine === "followup" ? "追问" : "跳过"} | ${row.outcome} | ${row.reason.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")} |`,
    ),
  ];
  return {
    passed,
    metrics,
    verdict,
    thresholdRows,
    sampleRows,
    failureLines: failures.map((f) => `${f.label}：${f.error}`),
    retriedSucceededLines: merged.retriedSucceeded.map(
      (r) => `${r.label}：${r.firstError}（初次失败，定向补跑成功）`,
    ),
    artifacts: { comparison, verdictMap },
  };
}

async function runFollowupSuite(): Promise<{ exitCode: number }> {
  const { tasks: allTasks } = loadGateSampleSet();
  let tasks = allTasks;
  if (onlyFilter) {
    const all = allTasks.map(gateSampleLabel);
    const unknown = onlyFilter.filter((label) => !all.includes(label));
    if (unknown.length > 0) throw new Error(`--only 包含未知样本标签：${unknown.join(", ")}`);
    tasks = allTasks.filter((task) => onlyFilter.includes(gateSampleLabel(task)));
  }
  const human = loadGateHumanReviewFile(tasks);

  const version = live ? await resolveRegressionVersion(SUITE_PROMPT_NAME.followup) : null;
  const versionLabel = live ? version!.version : (versionArg ?? "mock");
  const runner: GateRunner = live
    ? (() => {
        const client = createAiClientFromEnv();
        return async (input) => {
          const result = await client.chatCompletion({
            messages: buildFollowupMessages(input, version!.templates),
            temperature: 0.3, // 与生产链路一致（server/ai/followup.ts generateFollowups 同参数）
            maxCompletionTokens: 4096,
            responseFormat: { type: "json_object" },
          });
          return parseFollowupGateOutput(result.content);
        };
      })()
    : createMockGateRunner(tasks);

  console.log(
    `回归套件 followup（${live ? "live" : "mock"}，版本 ${versionLabel}，双跑确认 ${confirmRuns} 遍）：${tasks.length} 份样本串行判定中…${live ? "（真实调用 DeepSeek，产生 token 消耗）" : ""}`,
  );
  const runs = await runWithConfirmation<FollowupGateMetrics>({
    runOnce: (cache) => executeFollowupRun(tasks, human, runner, cache as JsonlCache<FollowupCacheEntry> | undefined),
    newCache: (round) =>
      cacheArg
        ? (loadJsonlCache(
            round === 0 ? path.resolve(cacheArg) : retryCachePath(path.resolve(cacheArg), round),
            isFollowupCacheEntry,
          ) as never)
        : undefined,
  });

  // 样本级双跑确认（两遍都跑完才判定）：两遍单跑皆未过时，逐样本对齐两遍判定——
  // 两遍一致才计确认放水/确认误伤；遍间不一致进边界抖动清单（不计失败），抖动率超线仍阻断
  let sampleConfirm: SampleConfirmResult | null = null;
  let sampleGate: GateVerdict | null = null;
  if (runs.length >= 2 && runs.every((run) => !run.passed)) {
    sampleConfirm = confirmSampleRuns({
      tasks,
      human,
      runs: runs.map(
        (run) =>
          new Map(
            Object.entries(
              run.artifacts.verdictMap as Record<string, { machine: "followup" | "skip"; reason: string }>,
            ),
          ),
      ),
    });
    sampleGate = evaluateFollowupSampleGate(sampleConfirm, {
      missMax: followupThresholds.missMax,
      harmRateMax: followupThresholds.harmRateMax,
      flakyRateMax,
    });
    console.log(
      `样本级确认：确认放水 ${sampleConfirm.confirmedMissCount} / 确认误伤率 ${sampleConfirm.confirmedHarmRate === null ? "—" : `${(sampleConfirm.confirmedHarmRate * 100).toFixed(1)}%`} / 边界抖动率 ${(sampleConfirm.flakyRate * 100).toFixed(1)}%（阈值 ≤ ${(flakyRateMax * 100).toFixed(1)}%）→ ${sampleGate.passed ? "达标" : "未达标"}`,
    );
  }
  const aggregate = aggregateConfirmRuns(
    runs.map((r) => ({ passed: r.passed })),
    { sampleConfirmedPassed: sampleGate?.passed === true },
  );
  const first = runs[0];
  // consistencyScore 口径：first-pass/flaky-pass 取对应遍的单跑放水数；confirmed-pass 取确认放水数
  const confirmingMissCount =
    aggregate.passKind === "flaky-pass"
      ? runs[runs.length - 1].metrics.missCount
      : aggregate.passKind === "confirmed-pass" && sampleConfirm
        ? sampleConfirm.confirmedMissCount
        : first.metrics.missCount;

  const reportParams = {
    suite: "followup" as const,
    versionLabel,
    mode: live ? ("live" as const) : ("mock" as const),
    model: live ? AI_MODEL : "mock",
    generatedAt: new Date(),
    thresholds: first.thresholdRows,
    verdictPassed: aggregate.passed,
    sampleRows: first.sampleRows,
    failures: first.failureLines,
    retriedSucceeded: first.retriedSucceededLines,
    confirmRuns:
      confirmRuns >= 2
        ? {
            passKind: aggregate.passKind,
            runs: runs.map((run, index) => ({
              label: index === 0 ? "首跑" : `复跑${index}`,
              thresholds: run.thresholdRows,
              verdictPassed: run.passed,
            })),
          }
        : undefined,
    extraSections:
      runs.length > 1
        ? [{ title: "复跑逐样本明细", rows: runs[runs.length - 1].sampleRows }]
        : undefined,
    // 样本级确认区块（仅双跑且触发样本级判定时下发；单跑/首跑即过不出现）
    sampleConfirm:
      sampleConfirm && sampleGate
        ? {
            thresholdRows: [
              {
                metric: "确认放水数（所有遍一致判跳过）",
                actual: String(sampleConfirm.confirmedMissCount),
                threshold: `≤ ${followupThresholds.missMax}`,
                passed: sampleConfirm.confirmedMissCount <= followupThresholds.missMax,
              },
              {
                metric: "确认误伤率（所有遍一致判追问）",
                actual:
                  sampleConfirm.confirmedHarmRate === null
                    ? "无可比样本"
                    : `${(sampleConfirm.confirmedHarmRate * 100).toFixed(1)}%`,
                threshold: `≤ ${(followupThresholds.harmRateMax * 100).toFixed(1)}%`,
                passed:
                  sampleConfirm.confirmedHarmRate === null ||
                  sampleConfirm.confirmedHarmRate <= followupThresholds.harmRateMax,
              },
              {
                metric: "边界抖动率",
                actual: `${(sampleConfirm.flakyRate * 100).toFixed(1)}%`,
                threshold: `≤ ${(flakyRateMax * 100).toFixed(1)}%`,
                passed: sampleConfirm.flakyRate <= flakyRateMax,
              },
            ],
            confirmedLines: sampleConfirm.rows
              .filter((row) => row.kind === "confirmed-miss" || row.kind === "confirmed-harm")
              .map((row) => {
                const humanText = row.human === "followup" ? "该追问" : "不该追问";
                const runsText = row.runs
                  .map((r) => (r.machine === "followup" ? "追问" : r.machine === "skip" ? "跳过" : "无判定"))
                  .join(" / ");
                return `- ${row.label}（${row.blindId}）：人审${humanText}，各遍均判「${runsText}」（${row.kind === "confirmed-miss" ? "确认放水" : "确认误伤"}）`;
              }),
            flakyLines: sampleConfirm.rows
              .filter((row) => row.kind === "flaky")
              .map((row) => {
                const humanText =
                  row.human === "followup" ? "该追问" : row.human === "skip" ? "不该追问" : "灰区";
                const runsText = row.runs
                  .map((r, index) => {
                    const label = index === 0 ? "首跑" : `复跑${index}`;
                    const verdict =
                      r.machine === null ? "无判定" : r.machine === "followup" ? "追问" : "跳过";
                    return `${label} ${verdict}（${truncateText(r.reason, 40)}）`;
                  })
                  .join(" / ");
                return `- ${row.label}（${row.blindId}）：人审${humanText}；${runsText}`;
              }),
          }
        : undefined,
  };
  const report = formatRegressionReport(reportParams);
  if (confirmRuns >= 2) {
    console.log(`\n双跑结论：${passKindLabel(aggregate.passKind)}`);
  }

  await persistRun({
    suite: "followup",
    version,
    versionLabel,
    report,
    reportParams,
    consistencyScore: confirmingMissCount,
    extra: {
      passKind: aggregate.passKind,
      runs: runs.map((run, index) => ({
        label: index === 0 ? "first" : `retry${index}`,
        metrics: run.metrics,
        verdictPassed: run.passed,
        failures: run.failureLines,
      })),
      // 样本级确认全文（确认值 + 抖动清单 + 抖动率 + 判定结果）
      sampleConfirm: sampleConfirm
        ? {
            confirmedMissCount: sampleConfirm.confirmedMissCount,
            confirmedHarmCount: sampleConfirm.confirmedHarmCount,
            confirmedHarmRate: sampleConfirm.confirmedHarmRate,
            flakyCount: sampleConfirm.flakyCount,
            flakyRate: sampleConfirm.flakyRate,
            flakyRateMax,
            gatePassed: sampleGate?.passed ?? null,
            flakySamples: sampleConfirm.rows
              .filter((row) => row.kind === "flaky")
              .map((row) => ({ label: row.label, blindId: row.blindId, human: row.human })),
            confirmedSamples: sampleConfirm.rows
              .filter((row) => row.kind === "confirmed-miss" || row.kind === "confirmed-harm")
              .map((row) => ({ label: row.label, blindId: row.blindId, kind: row.kind })),
          }
        : null,
      ...first.artifacts,
    },
  });
  return { exitCode: aggregate.passed ? 0 : 1 };
}

/** 抖动清单理由摘要：截断防超长行 */
function truncateText(text: string, max: number): string {
  const flat = text.replace(/\r?\n/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/* ============================== 报告落盘与 eval_runs 留档 ============================== */

function timestampSlug(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function persistRun(input: {
  suite: Suite;
  version: ResolvedVersion | null;
  versionLabel: string;
  report: string;
  reportParams: unknown;
  consistencyScore: number | null;
  extra: unknown;
}): Promise<void> {
  // mock 默认只打印不落盘；live 写默认报告路径 + eval_runs 留档
  const reportFile = outPath
    ? path.resolve(outPath)
    : live
      ? path.resolve(`docs/v2/regression/${input.suite}-${input.versionLabel}-${timestampSlug(new Date())}.md`)
      : null;
  if (reportFile) {
    mkdirSync(path.dirname(reportFile), { recursive: true });
    writeFileSync(reportFile, input.report, "utf8");
    console.log(`报告已写入：${reportFile}`);
  } else {
    console.log("（mock 模式未指定 --out，报告仅打印不落盘，不写 eval_runs）");
  }
  if (!live) return;
  // eval_runs 留档（live 模式每次运行）：consistencyScore 口径——scoring 存 MAE、followup 存放水数
  await insertEvalRun(prisma, {
    promptVersionId: input.version!.id,
    consistencyScore: input.consistencyScore,
    report: {
      suite: input.suite,
      version: input.versionLabel,
      generatedAt: new Date().toISOString(),
      reportFile,
      ...(input.reportParams as object),
      ...(input.extra as object),
    } as never,
  });
  console.log("eval_runs 已留档。");
}

/* ============================== 入口 ============================== */

try {
  const { exitCode } = suite === "scoring" ? await runScoringSuite() : await runFollowupSuite();
  process.exit(exitCode);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
