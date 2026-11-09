import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";

/**
 * 逐维题序与加深判定纯函数（T27 / D30 / BR-V2-6，切片 1：核心逻辑，不调 AI）。
 *
 * - 题序 = ABILITY_DIMENSIONS 八维固定顺序（`server/modules/profile/schema.ts` 为事实源）；
 *   逐维取 kind=baseline 且 published 的题（调用方负责过滤），主测维度以 abilityTags
 *   首位标签为准（内容侧由 T33 保证）；
 * - 一维多题时按内容侧约定候选顺序（id 升序）取第 1 道为主题，第 2 道为该维加深候选，
 *   第 3 道起忽略（本切片不消费）；
 * - 加深判定（BR-V2-6）：某维首题评分落库后该维度 Score.confidence < 阈值（默认 70，
 *   可注入）→ 追加该维未用的第 2 道候选题；confidence 为 NULL 或缺失（未评分）一律
 *   不触发——防止 AI 输出波动拉长测评；每维至多加深 1 题；总题数上限 12
 *   （8 + 至多 MAX_DEEPEN_DIMENSIONS 维加深）；
 * - 阈值经参数注入（默认 DEFAULT_DEEPEN_CONFIDENCE_THRESHOLD）；阈值调 0 等效关闭加深、
 *   回到固定 8 题（任务文件「失败与回滚」降级开关约定）。
 *
 * 本切片仅交付纯逻辑；getBaselineStatus / getOrCreateBaselineSession 的题序生效与
 * 完成判定接线属切片 2。
 */

/** 基线题最小信息（题序与加深判定输入；abilityTags 为 jsonb，防御读取） */
export interface BaselineQuestionLite {
  id: string;
  abilityTags: unknown;
}

/** 单维题序计划：第 1 道为主题，第 2 道为该维加深候选（一维一题时无候选） */
export interface DimensionPlan<T extends BaselineQuestionLite = BaselineQuestionLite> {
  dimension: string;
  primary: T;
  deepenCandidate: T | null;
}

/** 主测维度 = abilityTags 首位标签；脏数据（非数组/空数组/非字符串）返回 null */
export function primaryDimensionOf(question: BaselineQuestionLite): string | null {
  const tags = question.abilityTags;
  if (!Array.isArray(tags)) return null;
  const first = tags[0];
  return typeof first === "string" && first.trim() ? first : null;
}

/**
 * 八维固定顺序逐维取题：
 * - 按 abilityTags 首位标签把题归入维度；脏数据题不归入任何维度（跳过不报错）；
 * - 每维候选按 id 升序（内容侧约定顺序）取前 2 道：第 1 道主题、第 2 道加深候选；
 * - 某维无题该维跳过；空题库返回空计划（required=false 兜底由服务层保持）。
 */
export function planBaselineItems<T extends BaselineQuestionLite>(
  questions: T[],
  dimensions: readonly string[] = ABILITY_DIMENSIONS,
  anchoredPrimaryByDimension: ReadonlyMap<string, string> = new Map(),
): DimensionPlan<T>[] {
  const byDimension = new Map<string, T[]>();
  for (const question of questions) {
    const dimension = primaryDimensionOf(question);
    if (!dimension) continue;
    const list = byDimension.get(dimension) ?? [];
    list.push(question);
    byDimension.set(dimension, list);
  }
  const plan: DimensionPlan<T>[] = [];
  for (const dimension of dimensions) {
    const candidates = (byDimension.get(dimension) ?? [])
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    const eligible = candidates.slice(0, 2);
    const primary = eligible.find((candidate) => candidate.id === anchoredPrimaryByDimension.get(dimension)) ?? eligible[0];
    if (!primary) continue;
    plan.push({ dimension, primary, deepenCandidate: eligible.find((candidate) => candidate.id !== primary.id) ?? null });
  }
  return plan;
}

/** 加深判定阈值默认值（BR-V2-6 初定；T28 回归集标定后可经配置调整） */
export const DEFAULT_DEEPEN_CONFIDENCE_THRESHOLD = 70;
/** 加深维度数上限：8 题起步 + 至多 4 维加深 = 总题数 ≤12（D30） */
export const MAX_DEEPEN_DIMENSIONS = 4;

/** 一条加深决定：该维追加的候选题 id（每维至多 1 条） */
export interface DeepenDecision {
  dimension: string;
  questionId: string;
}

/**
 * 加深判定（纯函数）：
 * - confidenceByDimension 缺失（该维未评分）或值为 NULL → 不触发；
 * - confidence < threshold 且该维有未用候选 → 追加（输出天然每维至多 1 条）；
 * - 触发维度超过 maxDeepenDimensions 时按八维题序取前 N 维（默认 4，8+4=12 封顶）；
 * - 候选题 id 去重（防御同题多维度误标）。
 */
export function decideDeepenQuestions(input: {
  plan: DimensionPlan[];
  /** 各维首题评分置信度（Score.confidence；NULL = 无置信度信息） */
  confidenceByDimension: ReadonlyMap<string, number | null>;
  /** 加深阈值：confidence 低于该值触发（默认 70；调 0 等效关闭加深） */
  threshold?: number;
  /** 加深维度数上限（默认 4：8+4=12） */
  maxDeepenDimensions?: number;
}): DeepenDecision[] {
  const threshold = input.threshold ?? DEFAULT_DEEPEN_CONFIDENCE_THRESHOLD;
  const maxDeepen = input.maxDeepenDimensions ?? MAX_DEEPEN_DIMENSIONS;
  const decisions: DeepenDecision[] = [];
  const usedQuestionIds = new Set<string>();
  for (const item of input.plan) {
    if (decisions.length >= maxDeepen) break;
    const confidence = input.confidenceByDimension.get(item.dimension);
    // NULL（无置信度信息）与缺失（未评分）一律不触发：AI 输出波动不拉长测评
    if (confidence === undefined || confidence === null) continue;
    if (confidence >= threshold) continue;
    const candidate = item.deepenCandidate;
    if (!candidate || usedQuestionIds.has(candidate.id)) continue;
    usedQuestionIds.add(candidate.id);
    decisions.push({ dimension: item.dimension, questionId: candidate.id });
  }
  return decisions;
}
