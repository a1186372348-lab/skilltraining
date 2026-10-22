// 基线 8 题双评审校准脚本：对 content/eval/ 评分样本跑 Rubric 评分，
// 校验评分器在能力模型 v0.2 新尺子下与样本质量标注的一致性（分离度 / 立场中立性 / 承认未知）。
// 若存在 content/eval/baseline-8-human-review.json（人审盲评总分），追加「机器主测维度分 × 人审总分」对齐分析（T33 校准 R2）。
// 用法：
//   node scripts/eval-baseline-samples.ts                # mock 模式（默认）：确定性桩评分，离线验证报告管线（只打印不落盘）
//   node --env-file=.env scripts/eval-baseline-samples.ts --live
//                                                        # 真实模式：经 AI 网关（DeepSeek）评分（密钥经环境变量读取，不打印不落盘），
//                                                        # 串行执行，单样本失败重试 2 次后记录跳过；报告写入 docs/v2/calibration-report-baseline-8.md
//   可选：--out <路径> 覆盖报告输出位置（mock 模式下指定 --out 才会落盘）
//   可选：--only B5#2,B7#1 只跑指定样本（定向补跑失败样本用；子集上的汇总分析不代表整批结论，输出仅作补丁合并）
//   可选：--cache <路径> 逐份落盘 + 断点续跑：每份样本评分成功即追加一行 JSONL；
//         中断或部分失败后同一命令重跑，已缓存样本直接命中跳过，只补缺失的（接口不稳定时避免整批重来）
// 退出码：题目/样本文件加载或校验失败 → 1；整批跑完（含跳过失败样本）→ 0，结论以报告为准
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { AI_MODEL } from "../server/ai/client.ts";
import {
  scoreWithRubric,
  type RubricScoringOutput,
} from "../server/modules/scoring/rubric-scorer.ts";
import {
  analyzeHumanAlignment,
  analyzeScores,
  buildVerdict,
  createMockEvalScorer,
  fmt,
  formatConsoleSummary,
  formatMarkdownReport,
  overallScore,
  sampleLabel,
  type EvalSampleTask,
  type EvalScorer,
  type HumanReviewData,
  type SampleFailure,
  type SampleScore,
} from "./lib/eval-calibration.ts";
import { loadBaselineSampleSet, loadHumanReviewMapIfExists } from "./lib/eval-sample-loaders.ts";

const BASELINE_QUESTION_IDS = ["B3", "B5", "B7", "B10", "B12", "B14", "B16", "B17"] as const;
const DEFAULT_REPORT_PATH = path.resolve("docs/v2/calibration-report-baseline-8.md");
/** 单样本失败后的额外重试次数（共最多 1 + 2 = 3 次调用） */
const MAX_SAMPLE_RETRIES = 2;

const live = process.argv.includes("--live");
const mode = live ? ("live" as const) : ("mock" as const);
const outIndex = process.argv.indexOf("--out");
const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
if (outIndex >= 0 && !outPath) {
  console.error("--out 需要跟一个文件路径参数");
  process.exit(1);
}
// --only B5#2,B7#1：只跑指定样本（定向补跑）；空值或未知标签直接报错，避免静默全量跑
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

/** 缓存行：按样本标签（如 B5#2）索引评分输出；quality 以当前 eval 文件为准，不入缓存 */
interface CacheEntry {
  label: string;
  output: RubricScoringOutput;
  overall: number;
  attempts: number;
}

interface ScoreCache {
  path: string;
  entries: Map<string, CacheEntry>;
}

/** 读取既有缓存；单行解析失败仅忽略该行（缓存可重建，不因此中断） */
function loadCache(file: string): ScoreCache {
  const entries = new Map<string, CacheEntry>();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as CacheEntry;
        if (typeof entry.label === "string" && entry.output) entries.set(entry.label, entry);
      } catch {
        console.error(`缓存行解析失败，已忽略：${trimmed.slice(0, 60)}…`);
      }
    }
  }
  mkdirSync(path.dirname(file), { recursive: true });
  return { path: file, entries };
}

/** 加载 8 题的题库 YAML 与对应 eval 样本（共享加载器，T28 切片 2；寻址与校验语义不变） */
function loadTasks(): EvalSampleTask[] {
  return loadBaselineSampleSet().tasks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读取人审盲评对齐数据（共享加载器；文件不存在返回 null 跳过对齐分析，非法则报错中断） */
function loadHumanReview(): HumanReviewData | null {
  return loadHumanReviewMapIfExists();
}

/** 串行跑全部样本：缓存命中直接跳过；单样本失败重试 2 次，仍失败则记录后跳过，不中断整批；成功即写缓存 */
async function runAll(
  tasks: EvalSampleTask[],
  scorer: EvalScorer,
  cache?: ScoreCache,
): Promise<{ scores: SampleScore[]; failures: SampleFailure[] }> {
  const scores: SampleScore[] = [];
  const failures: SampleFailure[] = [];
  let done = 0;
  for (const task of tasks) {
    done += 1;
    const label = sampleLabel(task);
    const cached = cache?.entries.get(label);
    if (cached) {
      scores.push({ task, output: cached.output, overall: cached.overall, attempts: cached.attempts });
      console.log(`[${done}/${tasks.length}] ${label}（${task.quality}）均分 ${fmt(cached.overall)}（缓存命中）`);
      continue;
    }
    let attempts = 0;
    let lastError: string | null = null;
    while (attempts <= MAX_SAMPLE_RETRIES) {
      attempts += 1;
      try {
        const output = await scorer(task.input);
        const overall = overallScore(output);
        scores.push({ task, output, overall, attempts });
        if (cache) {
          appendFileSync(cache.path, `${JSON.stringify({ label, output, overall, attempts })}\n`, "utf8");
          cache.entries.set(label, { label, output, overall, attempts });
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
        `[${done}/${tasks.length}] ${sampleLabel(task)}（${task.quality}）评分失败（${attempts} 次尝试），已跳过：${lastError}`,
      );
    } else {
      const score = scores[scores.length - 1];
      console.log(
        `[${done}/${tasks.length}] ${sampleLabel(task)}（${task.quality}）均分 ${fmt(score.overall)}${attempts > 1 ? `（第 ${attempts} 次尝试成功）` : ""}`,
      );
    }
  }
  return { scores, failures };
}

let tasks: EvalSampleTask[];
let humanReview: HumanReviewData | null;
try {
  tasks = loadTasks();
  humanReview = loadHumanReview();
  if (onlyFilter) {
    const all = tasks.map(sampleLabel);
    const unknown = onlyFilter.filter((label) => !all.includes(label));
    if (unknown.length > 0) {
      throw new Error(`--only 包含未知样本标签：${unknown.join(", ")}（可选：${all.join(", ")}）`);
    }
    tasks = tasks.filter((task) => onlyFilter.includes(sampleLabel(task)));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.log(
  `基线 8 题评分校准（${mode} 模式）：${BASELINE_QUESTION_IDS.length} 题 × 共 ${tasks.length} 份样本，串行评分中…${humanReview ? "（含人审对齐分析）" : "（未找到人审对齐数据，跳过）"}`,
);

const scorer: EvalScorer = live ? (input) => scoreWithRubric(input) : createMockEvalScorer(tasks);
const cache = cacheArg ? loadCache(path.resolve(cacheArg)) : undefined;
if (cache) {
  console.log(`断点缓存：${cache.path}（已缓存 ${cache.entries.size} 份，命中将直接跳过）`);
}
const { scores, failures } = await runAll(tasks, scorer, cache);

const analysis = analyzeScores(scores);
const verdict = buildVerdict(analysis, failures);
const humanAlignment = humanReview ? analyzeHumanAlignment(scores, humanReview) : null;
const reportParams = {
  mode,
  model: AI_MODEL,
  generatedAt: new Date(),
  scores,
  failures,
  analysis,
  verdict,
  humanAlignment,
};

console.log(`\n${formatConsoleSummary(reportParams)}`);

// mock 默认只打印不落盘；live 或显式 --out 时写入报告文件
const reportFile = outPath ? path.resolve(outPath) : live ? DEFAULT_REPORT_PATH : null;
if (reportFile) {
  writeFileSync(reportFile, formatMarkdownReport(reportParams), "utf8");
  console.log(`\n报告已写入：${reportFile}`);
} else {
  console.log("\n（mock 模式未指定 --out，报告仅打印不落盘）");
}
