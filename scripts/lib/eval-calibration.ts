// 基线 8 题双评审校准纯函数：评分样本打分结果 → 分离度 / 立场中立性 / 承认未知分析 → 三档结论与报告
// 供 scripts/eval-baseline-samples.ts 调用；live 与 mock 数据共用同一条分析与报告管线。
// 校准目标（能力模型 v0.2 §9 反机械化规则）：
// - high 样本分数应显著高于 low/medium 锚点样本（分离度）；
// - 同题不同立场的 high 样本应都得高分（立场中立性，分差 >15 记异常）；
// - 「合理承认未知」的 high 样本不应被显著压低（与同题其他 high 分差 >15 记异常）。

import type { QuestionContent } from "../../server/modules/content/question-schema.ts";
import type { AnswerSample } from "../../server/modules/content/reference-answers.ts";
import type {
  RubricScoringInput,
  RubricScoringOutput,
} from "../../server/modules/scoring/rubric-scorer.ts";

/** 同题不同立场 high 样本均分差超过该值 → 立场中立性异常 */
export const STANCE_GAP_THRESHOLD = 15;
/** 「承认未知」high 样本低于同题其他 high 均分超过该值 → 判定被显著压低 */
export const UNKNOWN_GAP_THRESHOLD = 15;
/** high 组与低锚点（low/medium）组均分差 ≥ 该值 → 分离健康 */
export const SEPARATION_HEALTHY_GAP = 20;
/** high 组与低锚点组均分差 < 该值 → 分离失效（计入系统性偏差判定） */
export const SEPARATION_FAIL_GAP = 10;

export interface EvalSampleTask {
  questionId: string;
  questionTitle: string;
  /** 样本在 eval 文件中的序号（1 起） */
  sampleIndex: number;
  quality: AnswerSample["quality"];
  note: string;
  input: RubricScoringInput;
}

export interface SampleScore {
  task: EvalSampleTask;
  output: RubricScoringOutput;
  /** 各维度 rawScore 的均值（跨题可比的总分口径） */
  overall: number;
  /** 实际调用次数（含重试） */
  attempts: number;
}

export interface SampleFailure {
  task: EvalSampleTask;
  error: string;
  attempts: number;
}

export type EvalScorer = (input: RubricScoringInput) => Promise<RubricScoringOutput>;

/**
 * 构造单份样本的评分输入（RubricScoringInput 契约）：
 * 样本文本同时作为「首答」与「终答」，追问列表为空——样本是单轮终稿、无多轮过程；
 * 评分 prompt 以终答为评分主体，首答仅用于理解思路变化，两轮同文不改变评分对象。
 */
export function buildSampleTasks(
  question: QuestionContent,
  answers: AnswerSample[],
): EvalSampleTask[] {
  return answers.map((sample, index) => ({
    questionId: question.id,
    questionTitle: question.title,
    sampleIndex: index + 1,
    quality: sample.quality,
    note: sample.note ?? "",
    input: {
      mainDimension: question.ability_tags[0], // 首标签即主测维度（与生产链路同一约定，T33 R3）
      mainQuestion: question.main_question,
      rubricDimensions: question.rubric.dimensions,
      firstAnswer: sample.text,
      followupQuestions: [],
      finalAnswer: sample.text,
    },
  }));
}

export function sampleLabel(task: EvalSampleTask): string {
  return `${task.questionId}#${task.sampleIndex}`;
}

/** 样本总分 = 各维度 rawScore 均值 */
export function overallScore(output: RubricScoringOutput): number {
  const sum = output.dimensions.reduce((acc, d) => acc + d.rawScore, 0);
  return sum / output.dimensions.length;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

/** 立场样本识别：note 形如「立场A高质量」「立场 B 高质量（反对下线）」 */
const STANCE_NOTE_PATTERN = /立场\s*[A-Za-zＡ-Ｚ]/;
/** 「合理承认未知」样本识别 */
const UNKNOWN_NOTE_PATTERN = /承认未知/;

export interface QuestionAnalysis {
  questionId: string;
  title: string;
  scores: SampleScore[];
  highMean: number | null;
  /** 低锚点组：优先 low；无 low 样本的题（如 B5）退用 medium */
  anchorQuality: "low" | "medium" | null;
  anchorMean: number | null;
  /** highMean − anchorMean；任一侧缺失为 null（该题不参与分离度判定） */
  separationGap: number | null;
  /** 立场中立性：同题立场 high 样本均分最大差（≥2 份立场样本才可计算） */
  stance: { maxLabel: string; minLabel: string; gap: number } | null;
  stanceFlag: boolean;
  /** 承认未知：该样本均分 与 同题其他 high 均分 的差（其他 high 为空时不可计算） */
  unknown: { label: string; otherHighMean: number; gap: number } | null;
  unknownFlag: boolean;
}

export interface CalibrationAnalysis {
  questions: QuestionAnalysis[];
  /** 全部 high 样本总分跨题分布 */
  highDistribution: { count: number; min: number; max: number; mean: number } | null;
  highOverallMean: number | null;
  anchorOverallMean: number | null;
  /** 参与分离度判定的题数（high 与锚点均有有效分） */
  comparableCount: number;
  /** 人话结论素材 */
  stanceFindings: string[];
  unknownFindings: string[];
  weakSeparationFindings: string[];
  failedSeparationFindings: string[];
}

export function analyzeScores(scores: SampleScore[]): CalibrationAnalysis {
  const byQuestion = new Map<string, SampleScore[]>();
  for (const score of scores) {
    const list = byQuestion.get(score.task.questionId) ?? [];
    list.push(score);
    byQuestion.set(score.task.questionId, list);
  }

  const questions: QuestionAnalysis[] = [];
  const stanceFindings: string[] = [];
  const unknownFindings: string[] = [];
  const weakSeparationFindings: string[] = [];
  const failedSeparationFindings: string[] = [];

  for (const [questionId, list] of byQuestion) {
    const sorted = [...list].sort((a, b) => a.task.sampleIndex - b.task.sampleIndex);
    const high = sorted.filter((s) => s.task.quality === "high");
    const low = sorted.filter((s) => s.task.quality === "low");
    const medium = sorted.filter((s) => s.task.quality === "medium");
    const highMean = mean(high.map((s) => s.overall));
    const anchorQuality = low.length > 0 ? "low" : medium.length > 0 ? "medium" : null;
    const anchorGroup = low.length > 0 ? low : medium;
    const anchorMean = mean(anchorGroup.map((s) => s.overall));
    const separationGap =
      highMean !== null && anchorMean !== null ? highMean - anchorMean : null;

    if (separationGap !== null && anchorQuality !== null) {
      const text = `${questionId}：high 均分 ${fmt(highMean)} vs ${anchorQuality} 均分 ${fmt(anchorMean)}，分差 ${fmt(separationGap)}`;
      if (separationGap < SEPARATION_FAIL_GAP) {
        failedSeparationFindings.push(`${text}（< ${SEPARATION_FAIL_GAP}，分离失效）`);
      } else if (separationGap < SEPARATION_HEALTHY_GAP) {
        weakSeparationFindings.push(`${text}（< ${SEPARATION_HEALTHY_GAP}，分离偏弱）`);
      }
    }

    const stanceSamples = high.filter((s) => STANCE_NOTE_PATTERN.test(s.task.note));
    let stance: QuestionAnalysis["stance"] = null;
    let stanceFlag = false;
    if (stanceSamples.length >= 2) {
      const max = stanceSamples.reduce((a, b) => (a.overall >= b.overall ? a : b));
      const min = stanceSamples.reduce((a, b) => (a.overall <= b.overall ? a : b));
      stance = {
        maxLabel: sampleLabel(max.task),
        minLabel: sampleLabel(min.task),
        gap: max.overall - min.overall,
      };
      stanceFlag = stance.gap > STANCE_GAP_THRESHOLD;
      if (stanceFlag) {
        stanceFindings.push(
          `${questionId}：${stance.maxLabel}（${fmt(max.overall)}）与 ${stance.minLabel}（${fmt(min.overall)}）立场样本分差 ${fmt(stance.gap)} > ${STANCE_GAP_THRESHOLD}`,
        );
      }
    }

    let unknown: QuestionAnalysis["unknown"] = null;
    let unknownFlag = false;
    const unknownSample = high.find((s) => UNKNOWN_NOTE_PATTERN.test(s.task.note));
    if (unknownSample) {
      const otherHigh = high.filter((s) => s !== unknownSample);
      const otherHighMean = mean(otherHigh.map((s) => s.overall));
      if (otherHighMean !== null) {
        const gap = otherHighMean - unknownSample.overall;
        unknown = { label: sampleLabel(unknownSample.task), otherHighMean, gap };
        unknownFlag = gap > UNKNOWN_GAP_THRESHOLD;
        if (unknownFlag) {
          unknownFindings.push(
            `${questionId}：「承认未知」样本 ${unknown.label}（${fmt(unknownSample.overall)}）低于同题其他 high 均分 ${fmt(otherHighMean)}，差 ${fmt(gap)} > ${UNKNOWN_GAP_THRESHOLD}，疑似被压低`,
          );
        }
      }
    }

    questions.push({
      questionId,
      title: sorted[0]?.task.questionTitle ?? "",
      scores: sorted,
      highMean,
      anchorQuality,
      anchorMean,
      separationGap,
      stance,
      stanceFlag,
      unknown,
      unknownFlag,
    });
  }

  questions.sort((a, b) => a.questionId.localeCompare(b.questionId));

  const allHigh = scores.filter((s) => s.task.quality === "high").map((s) => s.overall);
  const allAnchor = scores
    .filter((s) => s.task.quality !== "high")
    .map((s) => s.overall);
  const highMeanAll = mean(allHigh);
  const anchorMeanAll = mean(allAnchor);

  return {
    questions,
    highDistribution:
      allHigh.length > 0
        ? {
            count: allHigh.length,
            min: Math.min(...allHigh),
            max: Math.max(...allHigh),
            mean: highMeanAll ?? 0,
          }
        : null,
    highOverallMean: highMeanAll,
    anchorOverallMean: anchorMeanAll,
    comparableCount: questions.filter((q) => q.separationGap !== null).length,
    stanceFindings,
    unknownFindings,
    weakSeparationFindings,
    failedSeparationFindings,
  };
}

export type CalibrationTier = "consistent" | "partial" | "systematic" | "insufficient-data";

export interface CalibrationVerdict {
  tier: CalibrationTier;
  /** 三档结论文案（insufficient-data 为数据不足时的兜底） */
  label: string;
  reasons: string[];
}

/**
 * 三档结论判定规则（报告内同样注明）：
 * - 系统性偏差：可比较题中 ≥ 半数 high/锚点分离失效（分差 < 10），或全局锚点均分 ≥ high 均分（整体倒挂）；
 * - 局部不一致：存在立场中立性异常、承认未知被压低，或任一题分离偏弱（分差 < 20）；
 * - 一致：以上均未命中；
 * - 数据不足：没有任何一题同时具备 high 与锚点有效分（如大量调用失败），不做结论。
 */
export function buildVerdict(
  analysis: CalibrationAnalysis,
  failures: SampleFailure[],
): CalibrationVerdict {
  const reasons: string[] = [];
  if (analysis.comparableCount === 0) {
    return {
      tier: "insufficient-data",
      label: "数据不足，无法判定（没有任何一题同时具备 high 与 low/medium 有效评分）",
      reasons: failures.length > 0 ? [`${failures.length} 份样本评分失败`] : ["无有效评分数据"],
    };
  }

  const inverted =
    analysis.highOverallMean !== null &&
    analysis.anchorOverallMean !== null &&
    analysis.anchorOverallMean >= analysis.highOverallMean;
  const systematic =
    inverted || analysis.failedSeparationFindings.length * 2 >= analysis.comparableCount;

  if (systematic) {
    if (inverted) {
      reasons.push(
        `全局 low/medium 锚点均分（${fmt(analysis.anchorOverallMean)}）≥ high 均分（${fmt(analysis.highOverallMean)}），质量分层整体倒挂`,
      );
    }
    if (analysis.failedSeparationFindings.length * 2 >= analysis.comparableCount) {
      reasons.push(
        `${analysis.failedSeparationFindings.length}/${analysis.comparableCount} 题 high 与锚点分离失效（分差 < ${SEPARATION_FAIL_GAP}）`,
      );
    }
    reasons.push(...analysis.failedSeparationFindings);
    return { tier: "systematic", label: "系统性偏差（需先修 prompt 再试测）", reasons };
  }

  const partial =
    analysis.stanceFindings.length > 0 ||
    analysis.unknownFindings.length > 0 ||
    analysis.failedSeparationFindings.length > 0 ||
    analysis.weakSeparationFindings.length > 0;
  if (partial) {
    reasons.push(...analysis.failedSeparationFindings);
    reasons.push(...analysis.weakSeparationFindings);
    reasons.push(...analysis.stanceFindings);
    reasons.push(...analysis.unknownFindings);
    return {
      tier: "partial",
      label: "局部不一致（列出需调优的维度与题型，调优后复跑校准）",
      reasons,
    };
  }

  reasons.push(
    `全部 ${analysis.comparableCount} 题 high 与 low/medium 锚点分离健康（分差 ≥ ${SEPARATION_HEALTHY_GAP}）`,
    `未发现立场中立性异常（阈值 ${STANCE_GAP_THRESHOLD} 分）`,
    `未发现「承认未知」样本被显著压低（阈值 ${UNKNOWN_GAP_THRESHOLD} 分）`,
  );
  if (failures.length > 0) {
    reasons.push(`注意：${failures.length} 份样本评分失败被跳过，结论基于成功样本`);
  }
  return { tier: "consistent", label: "评分器与样本标注一致（可直接进入试测）", reasons };
}

/**
 * 确定性桩评分：quality 定基线（high 85 / medium 65 / low 35），维度名哈希 ±5 抖动，
 * 离线验证报告管线（不真实出网）。按评分输入对象 identity 查样本 quality，不改动答案文本。
 */
export function createMockEvalScorer(tasks: EvalSampleTask[]): EvalScorer {
  const base: Record<AnswerSample["quality"], number> = { high: 85, medium: 65, low: 35 };
  const qualityByInput = new Map<RubricScoringInput, AnswerSample["quality"]>(
    tasks.map((task) => [task.input, task.quality]),
  );
  return async (input) => {
    const quality = qualityByInput.get(input) ?? "high";
    return {
      dimensions: Object.keys(input.rubricDimensions).map((dimension) => {
        const jitter = (hashString(`${dimension}|${input.mainQuestion}`) % 11) - 5;
        return {
          dimension,
          rawScore: Math.max(0, Math.min(100, base[quality] + jitter)),
          diagnosis: `mock 诊断（${dimension}）`,
        };
      }),
      topIssue: "mock 最需优化问题",
      nextFocus: "mock 下一步方向",
    };
  };
}

function hashString(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function fmt(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// ===== 人审对齐分析（T33 校准 R2；R3 修订指标口径：分档一致 / 分差 ±3 内占比 / 排序三组计数）=====

export interface HumanReviewSample {
  sampleIndex: number;
  blindId: string;
  humanScore: number;
}

export interface HumanReviewQuestion {
  mainDimension: string;
  samples: HumanReviewSample[];
}

export interface HumanReviewData {
  questions: Record<string, HumanReviewQuestion>;
}

export type ScoreBand = "优秀" | "高质量" | "较好但有明显缺项" | "部分达标" | "较弱" | "低质量";

/** 六档刻度（与人审口径一致）：90/80/70/60/40 为档界 */
export function scoreBand(score: number): ScoreBand {
  if (score >= 90) return "优秀";
  if (score >= 80) return "高质量";
  if (score >= 70) return "较好但有明显缺项";
  if (score >= 60) return "部分达标";
  if (score >= 40) return "较弱";
  return "低质量";
}

export interface HumanAlignmentRow {
  label: string; // 如 B14#3
  blindId: string;
  quality: string;
  humanScore: number;
  machineMain: number | null; // 主测维度机器分；输出缺该维度为 null
  diff: number | null; // machineMain − humanScore
  humanBand: ScoreBand;
  machineBand: ScoreBand | null;
}

export interface HumanAlignment {
  rows: HumanAlignmentRow[];
  comparedCount: number;
  meanAbsDiff: number | null;
  maxAbsDiff: { label: string; value: number } | null; // value 为绝对差
  bandMatchCount: number;
  /** 分差 |diff| ≤ 3（人审噪声带）内的可比样本数（R3 新增指标「分差 ±3 内占比」的分子） */
  withinNoiseCount: number;
  highHumanMeanMachine: number | null; // 人审 ≥70 样本的机器主测均值
  anchorMaxMachine: number | null; // 人审 <40 样本的机器主测最高分
  rankingMismatches: string[]; // 题内排序反转明细（人审差 >3 才计，±3 噪声带内互换不计）
  /** 题内排序三组计数（仅统计人审分差 > 噪声带且机器分齐全的样本对）：同序 / 机器并列 / 反转 */
  pairStats: { same: number; tied: number; reversed: number };
}

/** 人审分差超过该值才参与排序一致性判定（人审声明 ±3 为质量接近噪声带） */
export const HUMAN_NOISE_BAND = 3;

/** 机器主测分与人审总分均可比的行（machineMain / diff 非 null） */
function isCompared(row: HumanAlignmentRow): row is HumanAlignmentRow & { machineMain: number; diff: number } {
  return row.machineMain !== null && row.diff !== null;
}

/** 分数展示：整数原样、非整数保留一位小数 */
function fmtScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** 差值展示：带正负号 */
function fmtDiff(value: number): string {
  if (value === 0) return "0";
  return value > 0 ? `+${fmtScore(value)}` : `-${fmtScore(Math.abs(value))}`;
}

/**
 * 人审对齐分析：rows 按 questionId 升序、sampleIndex 升序；
 * 题内排序一致性只对人审分差 > 3 的样本对判定，机器并列不视为反转。
 */
export function analyzeHumanAlignment(scores: SampleScore[], human: HumanReviewData): HumanAlignment {
  const scoreByLabel = new Map<string, SampleScore>();
  for (const score of scores) {
    scoreByLabel.set(sampleLabel(score.task), score);
  }

  const rows: HumanAlignmentRow[] = [];
  const rankingMismatches: string[] = [];
  const pairStats = { same: 0, tied: 0, reversed: 0 };
  const questionIds = Object.keys(human.questions).sort((a, b) => a.localeCompare(b));

  for (const questionId of questionIds) {
    const hq = human.questions[questionId];
    const sortedSamples = [...hq.samples].sort((a, b) => a.sampleIndex - b.sampleIndex);
    const machineMainOf = (sampleIndex: number): number | null => {
      const score = scoreByLabel.get(`${questionId}#${sampleIndex}`);
      if (!score) return null;
      return score.output.dimensions.find((d) => d.dimension === hq.mainDimension)?.rawScore ?? null;
    };

    for (const sample of sortedSamples) {
      const machineMain = machineMainOf(sample.sampleIndex);
      rows.push({
        label: `${questionId}#${sample.sampleIndex}`,
        blindId: sample.blindId,
        quality: scoreByLabel.get(`${questionId}#${sample.sampleIndex}`)?.task.quality ?? "—",
        humanScore: sample.humanScore,
        machineMain,
        diff: machineMain === null ? null : machineMain - sample.humanScore,
        humanBand: scoreBand(sample.humanScore),
        machineBand: machineMain === null ? null : scoreBand(machineMain),
      });
    }

    // 题内排序一致性：人审分差 > 噪声带的每一对样本，机器主测顺序须与人审一致；
    // 三组计数：机器并列记 tied，顺序与人审一致记 same，反向记 reversed（并列不视为反转）
    for (let i = 0; i < sortedSamples.length; i += 1) {
      for (let j = i + 1; j < sortedSamples.length; j += 1) {
        const a = sortedSamples[i];
        const b = sortedSamples[j];
        const humanDiff = a.humanScore - b.humanScore;
        if (Math.abs(humanDiff) <= HUMAN_NOISE_BAND) continue;
        const machineA = machineMainOf(a.sampleIndex);
        const machineB = machineMainOf(b.sampleIndex);
        if (machineA === null || machineB === null) continue;
        if (machineA === machineB) {
          pairStats.tied += 1;
          continue;
        }
        if (humanDiff > 0 && machineA < machineB) {
          pairStats.reversed += 1;
          rankingMismatches.push(
            `${questionId}：人审 ${a.blindId}(${a.humanScore}) > ${b.blindId}(${b.humanScore}) 但机器 ${fmtScore(machineA)} < ${fmtScore(machineB)}`,
          );
        } else if (humanDiff < 0 && machineB < machineA) {
          pairStats.reversed += 1;
          rankingMismatches.push(
            `${questionId}：人审 ${b.blindId}(${b.humanScore}) > ${a.blindId}(${a.humanScore}) 但机器 ${fmtScore(machineB)} < ${fmtScore(machineA)}`,
          );
        } else {
          pairStats.same += 1;
        }
      }
    }
  }

  const compared = rows.filter(isCompared);
  let maxAbsDiff: HumanAlignment["maxAbsDiff"] = null;
  for (const row of compared) {
    if (maxAbsDiff === null || Math.abs(row.diff) > maxAbsDiff.value) {
      maxAbsDiff = { label: row.label, value: Math.abs(row.diff) };
    }
  }
  const withinNoiseCount = compared.filter((r) => Math.abs(r.diff) <= HUMAN_NOISE_BAND).length;
  const highHumanMachines = compared.filter((r) => r.humanScore >= 70).map((r) => r.machineMain);
  const anchorMachines = compared.filter((r) => r.humanScore < 40).map((r) => r.machineMain);

  return {
    rows,
    comparedCount: compared.length,
    meanAbsDiff: mean(compared.map((r) => Math.abs(r.diff))),
    maxAbsDiff,
    bandMatchCount: compared.filter((r) => r.humanBand === r.machineBand).length,
    withinNoiseCount,
    highHumanMeanMachine: mean(highHumanMachines),
    anchorMaxMachine: anchorMachines.length > 0 ? Math.max(...anchorMachines) : null,
    rankingMismatches,
    pairStats,
  };
}

/** 每题人审对齐紧凑行（console 摘要用）；该题无对齐数据时返回 null */
function questionAlignmentLine(questionId: string, alignment: HumanAlignment): string | null {
  const rows = alignment.rows.filter((r) => r.label.startsWith(`${questionId}#`));
  if (rows.length === 0) return null;
  const compared = rows.filter(isCompared);
  const bandMatch = compared.filter((r) => r.humanBand === r.machineBand).length;
  const reversedCount = alignment.rankingMismatches.filter((m) =>
    m.startsWith(`${questionId}：`),
  ).length;
  const ranking = reversedCount === 0 ? "无排序反转" : `排序反转 ${reversedCount} 组`;
  return `  → ${questionId} 人审对齐：|差|平均 ${fmt(mean(compared.map((r) => Math.abs(r.diff))))}，分档一致 ${bandMatch}/${compared.length}，${ranking}`;
}

/** 人审对齐全局指标块（console 摘要结论前） */
function humanAlignmentConsoleBlock(alignment: HumanAlignment): string[] {
  const bandRate =
    alignment.comparedCount > 0
      ? `${((alignment.bandMatchCount / alignment.comparedCount) * 100).toFixed(1)}%`
      : "—";
  const { same, tied, reversed } = alignment.pairStats;
  return [
    `人审对齐（机器主测维度 × 人审总分）：可比样本 ${alignment.comparedCount}/${alignment.rows.length}`,
    `  - 平均绝对差 ${fmt(alignment.meanAbsDiff)}；最大绝对差 ${alignment.maxAbsDiff ? `${alignment.maxAbsDiff.label}（${fmtScore(alignment.maxAbsDiff.value)}）` : "—"}`,
    `  - 分档一致 ${alignment.bandMatchCount}/${alignment.comparedCount}（${bandRate}）；分差 ±3 内占比 ${alignment.withinNoiseCount}/${alignment.comparedCount}`,
    `  - 排序：同序 ${same} 组、并列 ${tied} 组、反转 ${reversed} 组${reversed === 0 ? "（无排序反转）" : ""}`,
    `  - 人审 ≥70 样本机器主测均值 ${fmt(alignment.highHumanMeanMachine)}；人审 <40 样本机器主测最高 ${alignment.anchorMaxMachine === null ? "—" : fmtScore(alignment.anchorMaxMachine)}`,
  ];
}

/** 人审对齐 Markdown 小节（插入「逐样本明细」之前） */
function humanAlignmentMarkdown(alignment: HumanAlignment): string[] {
  const bandRate =
    alignment.comparedCount > 0
      ? `${((alignment.bandMatchCount / alignment.comparedCount) * 100).toFixed(1)}%`
      : "—";
  const maxAbs = alignment.maxAbsDiff
    ? `${alignment.maxAbsDiff.label}（${fmtScore(alignment.maxAbsDiff.value)}）`
    : "—";
  const lines: string[] = [
    "",
    "## 人审对齐（机器主测维度 × 人审总分）",
    "",
    "- 人审来源：`content/eval/baseline-8-human-review.json`（人审盲评总分，仅主测维度，等权分项合计 100）",
    "- 口径：机器分取该题主测维度 raw_score；差 = 机器主测 − 人审；人审声明 ±3 分为质量接近（噪声带），带内排序互换不计反转；分档：90~100 优秀 / 80~89 高质量 / 70~79 较好但有明显缺项 / 60~69 部分达标 / 40~59 较弱 / 0~39 低质量",
    "",
    "| 样本 | 盲评编号 | 预设质量 | 人审 | 机器主测 | 差 | 人审档 | 机器档 |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const row of alignment.rows) {
    lines.push(
      `| ${row.label} | ${row.blindId} | ${row.quality} | ${row.humanScore} | ${row.machineMain === null ? "—" : fmtScore(row.machineMain)} | ${row.diff === null ? "—" : fmtDiff(row.diff)} | ${row.humanBand} | ${row.machineBand ?? "—"} |`,
    );
  }
  lines.push(
    "",
    `- 指标汇总：可比样本 ${alignment.comparedCount}/${alignment.rows.length}；平均绝对差 ${fmt(alignment.meanAbsDiff)}；最大绝对差 ${maxAbs}；分档一致 ${alignment.bandMatchCount}/${alignment.comparedCount}（${bandRate}）；分差 ±3 内占比 ${alignment.withinNoiseCount}/${alignment.comparedCount}；人审 ≥70 机器均值 ${fmt(alignment.highHumanMeanMachine)}；人审 <40 机器最高 ${alignment.anchorMaxMachine === null ? "—" : fmtScore(alignment.anchorMaxMachine)}`,
    "",
    `**排序一致性**：同序 ${alignment.pairStats.same} 组、并列 ${alignment.pairStats.tied} 组、反转 ${alignment.pairStats.reversed} 组（人审分差 > ${HUMAN_NOISE_BAND} 才计，±${HUMAN_NOISE_BAND} 噪声带内互换不计；机器并列单独计为并列，不计同序也不计反转）：`,
    "",
  );
  if (alignment.rankingMismatches.length > 0) {
    lines.push(...alignment.rankingMismatches.map((m) => `- ⚠ ${m}`));
  } else {
    lines.push("- 无排序反转");
  }
  lines.push("");
  return lines;
}

export interface ReportParams {
  mode: "live" | "mock";
  model: string;
  generatedAt: Date;
  scores: SampleScore[];
  failures: SampleFailure[];
  analysis: CalibrationAnalysis;
  verdict: CalibrationVerdict;
  /** 人审对齐数据（T33 校准 R2）；无人审数据文件时为 null/缺省 */
  humanAlignment?: HumanAlignment | null;
}

/** 控制台紧凑摘要（逐样本一行 + 每题分离度与人审对齐 + 结论） */
export function formatConsoleSummary(params: ReportParams): string {
  const lines: string[] = [];
  for (const q of params.analysis.questions) {
    for (const s of q.scores) {
      const dims = s.output.dimensions.map((d) => `${d.dimension} ${d.rawScore}`).join(" / ");
      lines.push(
        `[${sampleLabel(s.task)}] ${s.task.quality.padEnd(6)} 均分 ${fmt(s.overall)} ｜ ${dims} ｜ top_issue: ${truncate(s.output.topIssue, 60)}`,
      );
    }
    const anchor =
      q.anchorQuality === null ? "无锚点样本" : `${q.anchorQuality} 均分 ${fmt(q.anchorMean)}`;
    lines.push(
      `  → ${q.questionId} 分离度：high 均分 ${fmt(q.highMean)} vs ${anchor}，分差 ${fmt(q.separationGap)}${q.stanceFlag ? " ｜ ⚠ 立场异常" : ""}${q.unknownFlag ? " ｜ ⚠ 承认未知被压低" : ""}`,
    );
    if (params.humanAlignment) {
      const alignmentLine = questionAlignmentLine(q.questionId, params.humanAlignment);
      if (alignmentLine) lines.push(alignmentLine);
    }
  }
  for (const f of params.failures) {
    lines.push(`[${sampleLabel(f.task)}] ${f.task.quality} 评分失败（${f.attempts} 次尝试）：${f.error}`);
  }
  if (params.humanAlignment) {
    lines.push(...humanAlignmentConsoleBlock(params.humanAlignment));
  }
  lines.push("----------------------------------------");
  lines.push(`结论：${params.verdict.label}`);
  for (const reason of params.verdict.reasons) {
    lines.push(`  - ${reason}`);
  }
  return lines.join("\n");
}

/** 完整 Markdown 报告（写入 docs/v2/calibration-report-baseline-8.md） */
export function formatMarkdownReport(params: ReportParams): string {
  const { analysis, verdict } = params;
  const date = params.generatedAt.toISOString().slice(0, 10);
  const total = params.scores.length + params.failures.length;
  const retried = params.scores.filter((s) => s.attempts > 1).length;
  const lines: string[] = [
    "# 基线 8 题评分校准报告（双评审：评分器 × 样本质量标注）",
    "",
    `- 生成日期：${date}（模式：${params.mode}${params.mode === "live" ? `，模型 ${params.model}，temperature 0.2 与线上一致` : "，确定性桩评分，仅验证报告管线"}）`,
    "- 校准对象：B3、B5、B7、B10、B12、B14、B16、B17（`content/questions/draft/` 已按能力模型 v0.2 新尺子返工）× `content/eval/` 每题 3~4 份评分样本",
    "- 构造方式：样本文本同时作为「首答」与「终答」，追问列表为空（样本是单轮终稿、无多轮过程；评分 prompt 以终答为评分主体，首答仅用于理解思路变化，两轮同文不改变评分对象）",
    `- 执行摘要：共 ${total} 份样本，成功 ${params.scores.length}，失败 ${params.failures.length}（单样本最多重试 2 次后跳过）${retried > 0 ? `；${retried} 份经重试成功` : ""}`,
    "- 总分口径：样本总分 = 该题各维度 raw_score 的算术平均（仅用于样本间比较，非线上有效分）",
    "",
    `## 结论：${verdict.label}`,
    "",
    ...verdict.reasons.map((r) => `- ${r}`),
    "",
    "### 判定规则（本报告口径）",
    "",
    `- 分离度：每题 high 组均分 − 锚点组均分；≥ ${SEPARATION_HEALTHY_GAP} 为健康，${SEPARATION_FAIL_GAP}~${SEPARATION_HEALTHY_GAP} 为偏弱，< ${SEPARATION_FAIL_GAP} 为失效（锚点 = low；B5 无 low 样本，退用 medium）`,
    `- 立场中立性：同题不同立场 high 样本总分差 > ${STANCE_GAP_THRESHOLD} 记异常`,
    `- 承认未知（能力模型 v0.2 §9 反机械化规则）：「合理承认未知」high 样本低于同题其他 high 均分 > ${UNKNOWN_GAP_THRESHOLD} 记被显著压低`,
    `- 系统性偏差 = 可比较题中 ≥ 半数分离失效，或全局锚点均分 ≥ high 均分；局部不一致 = 存在立场/承认未知异常或分离偏弱；其余为一致`,
    "",
    "## 汇总分析",
    "",
    "### 1. 每题分离度（high vs low/medium 锚点）",
    "",
    "| 题目 | high 均分 | 锚点 | 锚点均分 | 分差 | 判定 |",
    "|---|---|---|---|---|---|",
  ];
  for (const q of analysis.questions) {
    const judge =
      q.separationGap === null
        ? "数据不足"
        : q.separationGap < SEPARATION_FAIL_GAP
          ? "✗ 失效"
          : q.separationGap < SEPARATION_HEALTHY_GAP
            ? "△ 偏弱"
            : "✓ 健康";
    lines.push(
      `| ${q.questionId} ${escapeCell(q.title)} | ${fmt(q.highMean)} | ${q.anchorQuality ?? "—"} | ${fmt(q.anchorMean)} | ${fmt(q.separationGap)} | ${judge} |`,
    );
  }
  lines.push(
    "",
    "### 2. 跨题 high 样本总分分布",
    "",
    analysis.highDistribution
      ? `- 共 ${analysis.highDistribution.count} 份 high 样本：min ${fmt(analysis.highDistribution.min)} / max ${fmt(analysis.highDistribution.max)} / mean ${fmt(analysis.highDistribution.mean)}；全局锚点（low/medium）均分 ${fmt(analysis.anchorOverallMean)}`
      : "- 无 high 样本有效分",
    "",
    "### 3. 立场中立性",
    "",
  );
  if (analysis.stanceFindings.length > 0) {
    lines.push(...analysis.stanceFindings.map((f) => `- ⚠ ${f}`));
  } else {
    lines.push(`- 未发现 > ${STANCE_GAP_THRESHOLD} 分的立场分差（同题多立场 high 样本得分相当）`);
  }
  lines.push("", "### 4. 「合理承认未知」样本", "");
  if (analysis.unknownFindings.length > 0) {
    lines.push(...analysis.unknownFindings.map((f) => `- ⚠ ${f}`));
  } else {
    lines.push(`- 未发现「承认未知」样本被显著压低（阈值 ${UNKNOWN_GAP_THRESHOLD} 分）`);
  }
  if (params.failures.length > 0) {
    lines.push("", "### 5. 评分失败样本（重试 2 次后仍失败，已跳过）", "");
    for (const f of params.failures) {
      lines.push(`- ${sampleLabel(f.task)}（${f.task.quality}）：${escapeCell(f.error)}`);
    }
  }

  if (params.humanAlignment) {
    lines.push(...humanAlignmentMarkdown(params.humanAlignment));
  }

  lines.push("", "## 逐样本明细", "");
  for (const q of analysis.questions) {
    const dims = q.scores[0]?.output.dimensions.map((d) => d.dimension) ?? [];
    lines.push(
      `### ${q.questionId} ｜ ${escapeCell(q.title)}`,
      "",
      `| # | quality | ${dims.map((d) => `${d}`).join(" | ")} | 总分 | top_issue 摘要 |`,
      `|---|---|${dims.map(() => "---").join("|")}|---|---|`,
    );
    for (const s of q.scores) {
      const dimCells = s.output.dimensions.map((d) => String(d.rawScore)).join(" | ");
      lines.push(
        `| ${s.task.sampleIndex} | ${s.task.quality} | ${dimCells} | ${fmt(s.overall)} | ${escapeCell(truncate(s.output.topIssue, 100))} |`,
      );
    }
    lines.push("", "| # | 样本 note（质量标注用途） |", "|---|---|");
    for (const s of q.scores) {
      lines.push(`| ${s.task.sampleIndex} | ${escapeCell(s.task.note)} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
