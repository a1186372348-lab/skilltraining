// 追问闸门人审校准脚本（T35 / D37 步骤 5）：对 content/eval/ 31 份评分样本的首答跑追问闸门，
// 校验「首答后是否追问」的判定质量——核心指标是放水率（人审该追问但闸门判跳过，须趋近 0）
// 与误伤率（人审不该追问但闸门判追问，阈值人审裁定），灰区单独统计。
// 用法：
//   node scripts/eval-gate-samples.ts                      # mock 模式（默认）：确定性桩判定，离线验证报告管线（只打印不落盘）
//   node --env-file=.env scripts/eval-gate-samples.ts --live
//                                                          # live 跑批：真实调用 DeepSeek（密钥仅经环境变量注入，不打印不落盘；
//                                                          # 产生 token 消耗），串行执行，单样本失败重试 2 次后记录跳过；
//                                                          # 报告写入 docs/v2/gate-calibration-report.md
//   node scripts/eval-gate-samples.ts --blind-review       # 生成盲评材料：docs/v2/gate-blind-review-samples.md（不需要 AI，不联网）
//   node scripts/eval-gate-samples.ts --compare --cache <缓存路径>
//                                                          # 对照模式：读缓存中的机器结果 + content/eval/gate-human-review.json，
//                                                          # 输出对照表与指标并写入报告（不调 AI；人审数据就位后使用）
//   可选：--out <路径> 覆盖报告输出位置（mock/blind-review 模式下指定 --out 才会落盘）
//   可选：--only B5#2,B7#1 只跑指定样本（定向补跑失败样本用；子集上的汇总不代表整批结论，输出仅作补丁合并）
//   可选：--cache <路径> 逐份落盘 + 断点续跑：每份样本判定成功即追加一行 JSONL；
//         中断或部分失败后同一命令重跑，已缓存样本直接命中跳过，只补缺失的（接口不稳定时避免整批重来）
// 退出码：题目/样本/人审文件加载或校验失败 → 1；整批跑完（含跳过失败样本）→ 0，结论以报告为准
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { AI_MODEL, createAiClientFromEnv } from "../server/ai/client.ts";
import {
  buildFollowupMessages,
  parseFollowupGateOutput,
  type FollowupGateResult,
} from "../server/ai/followup.ts";
import {
  analyzeGateComparison,
  buildBlindReviewMarkdown,
  createMockGateRunner,
  formatGateConsoleSummary,
  formatGateMarkdownReport,
  gateSampleLabel,
  type BlindReviewQuestionGroup,
  type GateHumanReview,
  type GateMachineResult,
  type GateRunner,
  type GateSampleFailure,
  type GateSampleTask,
} from "./lib/gate-calibration.ts";
import {
  loadGateHumanReviewFile,
  loadGateSampleSet,
} from "./lib/eval-sample-loaders.ts";

const DEFAULT_REPORT_PATH = path.resolve("docs/v2/gate-calibration-report.md");
const BLIND_REVIEW_PATH = path.resolve("docs/v2/gate-blind-review-samples.md");
/** 单样本失败后的额外重试次数（共最多 1 + 2 = 3 次调用） */
const MAX_SAMPLE_RETRIES = 2;

const live = process.argv.includes("--live");
const blindReviewMode = process.argv.includes("--blind-review");
const compareMode = process.argv.includes("--compare");
const modeFlags = [live, blindReviewMode, compareMode].filter(Boolean).length;
if (modeFlags > 1) {
  console.error("--live / --blind-review / --compare 互斥，一次只能选一种模式");
  process.exit(1);
}
const outIndex = process.argv.indexOf("--out");
const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
if (outIndex >= 0 && !outPath) {
  console.error("--out 需要跟一个文件路径参数");
  process.exit(1);
}
// --only B5#2,B7#1：只跑指定样本（定向补跑）；空值直接报错，避免静默全量跑
const onlyIndex = process.argv.indexOf("--only");
const onlyFilter =
  onlyIndex >= 0
    ? (process.argv[onlyIndex + 1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : null;
if (onlyIndex >= 0 && (!onlyFilter || onlyFilter.length === 0)) {
  console.error("--only 需要跟逗号分隔的样本标签（如 B5#2,B7#1）");
  process.exit(1);
}
// --cache <路径>：逐份落盘 + 断点续跑（JSONL 逐行追加；成功样本才写入，失败样本下次重跑）
const cacheIndex = process.argv.indexOf("--cache");
const cacheArg = cacheIndex >= 0 ? process.argv[cacheIndex + 1] : undefined;
if (cacheIndex >= 0 && !cacheArg) {
  console.error("--cache 需要跟一个文件路径参数");
  process.exit(1);
}
if (compareMode && !cacheArg) {
  console.error("对照模式需要 --cache <路径> 指定机器结果缓存（先跑 --live --cache 产生）");
  process.exit(1);
}

/** 缓存行：按样本标签（如 B5#2）索引机器判定输出 */
interface CacheEntry {
  label: string;
  shouldFollowup: boolean;
  reason: string;
  followupCount: number;
  latencyMs: number;
  attempts: number;
}

interface GateCache {
  path: string;
  entries: Map<string, CacheEntry>;
}

/** 读取既有缓存；单行解析失败仅忽略该行（缓存可重建，不因此中断） */
function loadCache(file: string): GateCache {
  const entries = new Map<string, CacheEntry>();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as CacheEntry;
        if (typeof entry.label === "string" && typeof entry.shouldFollowup === "boolean") {
          entries.set(entry.label, entry);
        }
      } catch {
        console.error(`缓存行解析失败，已忽略：${trimmed.slice(0, 60)}…`);
      }
    }
  }
  mkdirSync(path.dirname(file), { recursive: true });
  return { path: file, entries };
}

/** 加载校准题集与样本（共享加载器，T28 切片 2；寻址与校验语义不变） */
function loadTasks(): GateSampleTask[] {
  return loadGateSampleSet().tasks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** live 闸门：与生产链路同一次调用（buildFollowupMessages → chatCompletion → parseFollowupGateOutput） */
function createLiveGateRunner(): GateRunner {
  const client = createAiClientFromEnv();
  return async (input) => {
    const result = await client.chatCompletion({
      messages: buildFollowupMessages(input),
      temperature: 0.3, // 与生产链路一致（server/ai/followup.ts generateFollowups 同参数）
      maxCompletionTokens: 4096,
      responseFormat: { type: "json_object" },
    });
    return parseFollowupGateOutput(result.content);
  };
}

/** 串行跑全部样本：缓存命中直接跳过；单样本失败重试 2 次，仍失败则记录后跳过，不中断整批；成功即写缓存 */
async function runAll(
  tasks: GateSampleTask[],
  runner: GateRunner,
  cache?: GateCache,
): Promise<{ results: GateMachineResult[]; failures: GateSampleFailure[] }> {
  const results: GateMachineResult[] = [];
  const failures: GateSampleFailure[] = [];
  let done = 0;
  for (const task of tasks) {
    done += 1;
    const label = gateSampleLabel(task);
    const cached = cache?.entries.get(label);
    if (cached) {
      results.push({
        task,
        shouldFollowup: cached.shouldFollowup,
        reason: cached.reason,
        followupCount: cached.followupCount,
        latencyMs: cached.latencyMs,
        attempts: cached.attempts,
      });
      console.log(`[${done}/${tasks.length}] ${label}（${task.blindId}）${cached.shouldFollowup ? "追问" : "跳过"}（缓存命中）`);
      continue;
    }
    let attempts = 0;
    let lastError: string | null = null;
    while (attempts <= MAX_SAMPLE_RETRIES) {
      attempts += 1;
      const startedAt = Date.now();
      try {
        const gate: FollowupGateResult = await runner(task.input);
        const latencyMs = Date.now() - startedAt;
        const entry: CacheEntry = {
          label,
          shouldFollowup: gate.shouldFollowup,
          reason: gate.reason,
          followupCount: gate.followups.length,
          latencyMs,
          attempts,
        };
        results.push({
          task,
          shouldFollowup: gate.shouldFollowup,
          reason: gate.reason,
          followupCount: gate.followups.length,
          latencyMs,
          attempts,
        });
        if (cache) {
          appendFileSync(cache.path, `${JSON.stringify(entry)}\n`, "utf8");
          cache.entries.set(label, entry);
        }
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message.split("\n")[0] : String(error);
        if (attempts <= MAX_SAMPLE_RETRIES) {
          await sleep(1000 * attempts);
        }
      }
    }
    if (lastError !== null) {
      failures.push({ task, error: lastError, attempts });
      console.error(
        `[${done}/${tasks.length}] ${label}（${task.blindId}）判定失败（${attempts} 次尝试），已跳过：${lastError}`,
      );
    } else {
      const result = results[results.length - 1];
      console.log(
        `[${done}/${tasks.length}] ${label}（${task.blindId}）${result.shouldFollowup ? "追问" : "跳过"}：${result.reason}${attempts > 1 ? `（第 ${attempts} 次尝试成功）` : ""}`,
      );
    }
  }
  return { results, failures };
}

/* ============================== 加载与模式分发 ============================== */

let tasks: GateSampleTask[];
try {
  tasks = loadTasks();
  if (onlyFilter) {
    const all = tasks.map(gateSampleLabel);
    const unknown = onlyFilter.filter((label) => !all.includes(label));
    if (unknown.length > 0) {
      throw new Error(`--only 包含未知样本标签：${unknown.join(", ")}（可选：${all.join(", ")}）`);
    }
    tasks = tasks.filter((task) => onlyFilter.includes(gateSampleLabel(task)));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// ---- 盲评材料模式：不需要 AI，按题分组输出（盲评防线由 buildBlindReviewMarkdown 与单测共同保证）----
if (blindReviewMode) {
  const groups: BlindReviewQuestionGroup[] = [];
  const byQuestion = new Map<string, GateSampleTask[]>();
  for (const task of tasks) {
    const list = byQuestion.get(task.questionId) ?? [];
    list.push(task);
    byQuestion.set(task.questionId, list);
  }
  for (const [questionId, questionTasks] of byQuestion) {
    groups.push({
      questionId,
      mainQuestion: questionTasks[0].input.mainQuestion,
      mainDimension: questionTasks[0].input.primaryDimension ?? questionTasks[0].questionTitle,
      samples: questionTasks.map((task) => ({ blindId: task.blindId, text: task.input.firstAnswer })),
    });
  }
  const markdown = buildBlindReviewMarkdown(groups, new Date());
  const target = outPath ? path.resolve(outPath) : BLIND_REVIEW_PATH;
  writeFileSync(target, markdown, "utf8");
  console.log(
    `盲评材料已写入：${target}（共 ${groups.length} 题 / ${tasks.length} 份样本；已隐去一切质量标注，仅以 blindId 标识）`,
  );
  process.exit(0);
}

// ---- 对照模式：机器结果来自缓存，人审判定来自 gate-human-review.json（不调 AI）----
if (compareMode) {
  const cache = loadCache(path.resolve(cacheArg!));
  const results: GateMachineResult[] = [];
  for (const task of tasks) {
    const entry = cache.entries.get(gateSampleLabel(task));
    if (!entry) continue;
    results.push({
      task,
      shouldFollowup: entry.shouldFollowup,
      reason: entry.reason,
      followupCount: entry.followupCount,
      latencyMs: entry.latencyMs,
      attempts: entry.attempts,
    });
  }
  let human: GateHumanReview;
  try {
    human = loadGateHumanReviewFile(tasks);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const comparison = analyzeGateComparison({ results, human, tasks });
  const params = {
    mode: "compare" as const,
    model: AI_MODEL,
    generatedAt: new Date(),
    results,
    failures: [],
    comparison,
  };
  console.log(`人审对照（机器结果 ${results.length}/${tasks.length} 份来自缓存 ${cache.path}）：`);
  console.log(formatGateConsoleSummary(params));
  const reportFile = outPath ? path.resolve(outPath) : DEFAULT_REPORT_PATH;
  writeFileSync(reportFile, formatGateMarkdownReport(params), "utf8");
  console.log(`\n报告已写入：${reportFile}`);
  process.exit(0);
}

// ---- mock / live 跑批模式 ----
const mode = live ? ("live" as const) : ("mock" as const);
console.log(
  `追问闸门校准（${mode} 模式）：${tasks.length} 份样本串行判定中…${live ? "（真实调用 DeepSeek，产生 token 消耗）" : "（确定性桩，离线验证管线）"}`,
);
const runner: GateRunner = live ? createLiveGateRunner() : createMockGateRunner(tasks);
const cache = cacheArg ? loadCache(path.resolve(cacheArg)) : undefined;
if (cache) {
  console.log(`断点缓存：${cache.path}（已缓存 ${cache.entries.size} 份，命中将直接跳过）`);
}
const { results, failures } = await runAll(tasks, runner, cache);

const params = {
  mode,
  model: AI_MODEL,
  generatedAt: new Date(),
  results,
  failures,
  comparison: null,
};
console.log(`\n${formatGateConsoleSummary(params)}`);

// mock 默认只打印不落盘；live 或显式 --out 时写入报告文件
const reportFile = outPath ? path.resolve(outPath) : live ? DEFAULT_REPORT_PATH : null;
if (reportFile) {
  writeFileSync(reportFile, formatGateMarkdownReport(params), "utf8");
  console.log(`\n报告已写入：${reportFile}`);
} else {
  console.log("\n（mock 模式未指定 --out，报告仅打印不落盘）");
}
