import type { PrismaClient, Question, TrainingSession } from "@prisma/client";

import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";
import { todayUtc } from "@/server/modules/training/service";

import { BASELINE_ERROR_CODES as CODES, BaselineError } from "./errors";
import {
  DEFAULT_DEEPEN_CONFIDENCE_THRESHOLD,
  decideDeepenQuestions,
  planBaselineItems,
  primaryDimensionOf,
} from "./plan";
import {
  createPrismaBaselineRepository,
  type BaselineRepository,
} from "./repository";

/**
 * 能力基线测评服务（T17a / D19 / BR-9；T36 / D38 双计数语义；T27 / D30 / BR-V2-6 八维题序与加深）。
 *
 * 规则：
 * - 题序（T27 切片 2，V1「published 按 id 升序」语义迁移）：按 `plan.ts` 的八维固定顺序
 *   逐维出题——主测维度以 abilityTags 首位标签归位，每维第 1 道为主题、第 2 道为加深候选；
 *   兼容桥：题库尚无八维标注的存量基线题（plan 为空）→ 回退 V1 id 升序语义；
 * - 加深（BR-V2-6）：某维主题评分落库后该维 Score.confidence < 阈值（默认 70，
 *   deps.deepenThreshold 或环境变量 BASELINE_DEEPEN_CONFIDENCE_THRESHOLD 注入，调 0 等效关闭）→
 *   该维候选题插入同维主题之后；confidence 为 NULL/未评分不触发；每维至多 1 次；
 *   total 语义 = 主题数（8）+ 已触发加深数（≤4，总题数 ≤12）；
 * - 双计数（T36 / D38 题间并行评分）：
 *   answeredCount = 序列内已提交终答（finalSubmittedAt 非空）的基线题去重数——流程推进口径，
 *     提交终答即进入下一题，不等评分；
 *   doneCount = 序列内已评分（scoredAt 非空）的基线题去重数——完成判定口径，
 *     全部主题与已触发加深题评完才写完成标记、才解锁日常训练；
 * - nextQuestion：序列内第一道未提交终答的题（断点续测：中途退出后回到该题）；边界——
 *   全部已作答未全部评完时 required=true 且 nextQuestion=null（由 today 路由挡回）；
 * - 全部评完 → 写 user_profiles.baseline_completed_at（守卫条件 updateMany，幂等：
 *   并发/重复调用只有首次写入，时间戳不被覆盖）；无画像行的用户跳过写入，不影响判定；
 * - 题库无基线题（T17b 未导入或全部下架）→ required=false，日常训练不受影响；
 * - 基线会话复用训练闭环（提示/追问/评分/独立完成系数完全一致），以 isExtra=true 落库：
 *   每日一题按 {userId, date, isExtra:false} 唯一复用，基线题不能占用该槽位，
 *   否则基线完成当天进入今日训练会错误复用基线会话；画像计入规则与加练一致（D3）。
 *
 * 分层（T27 切片 1，行为不变重构）：Prisma 查询全部下沉 repository.ts；
 * status 响应契约见 schemas.ts；逐维题序与加深判定纯逻辑见 plan.ts（本文件接线消费）。
 */

type DbClient = PrismaClient;

/** 基线状态查询的可选注入（仓储可替换；阈值可配置） */
export interface BaselineStatusDeps {
  repository?: BaselineRepository;
  /**
   * 加深阈值（BR-V2-6）：该维 Score.confidence 低于此值触发加深。
   * 优先级：deps.deepenThreshold > 环境变量 BASELINE_DEEPEN_CONFIDENCE_THRESHOLD > 默认 70；
   * 调 0 等效关闭加深、回到固定主题序列（任务文件「失败与回滚」降级开关约定）。
   */
  deepenThreshold?: number;
  /** 内部事务上下文：展示前持久化加深题。 */
  lockDeepens?: boolean;
}

/** 解析加深阈值：deps 显式注入 > 环境变量 > 默认 70（口径见 BaselineStatusDeps 注释） */
function resolveDeepenThreshold(deps: BaselineStatusDeps): number {
  if (deps.deepenThreshold !== undefined) return deps.deepenThreshold;
  const raw = process.env.BASELINE_DEEPEN_CONFIDENCE_THRESHOLD?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_DEEPEN_CONFIDENCE_THRESHOLD;
}

/** 题序条目：主题或已触发的加深题（isDeepen 供进度视图琥珀标记） */
interface SequenceItem {
  question: Question;
  isDeepen: boolean;
}

/** 逐题进度项（T27 切片 3 进度视图；FR-10：只含白名单字段，不携带题目内容） */
export interface BaselineProgressItem {
  questionId: string;
  /** 主测维度（八维题序口径；兼容桥存量无标注题为 null） */
  dimension: string | null;
  orderIndex: number;
  /** pending=未到 / active=进行中（已作答待评分或当前待作答第一题）/ scored=已评分 */
  state: "pending" | "active" | "scored";
  /** 加深题标记（confidence 触发追加的第 2 道候选；未触发不出现在序列） */
  isDeepen: boolean;
}

/** 完成后八维点亮预览项（BR-6：维度分 = 历史有效分简单平均；null = 未知） */
export interface DimensionPreviewItem {
  dimension: string;
  effectiveScore: number | null;
}

export interface BaselineStatus {
  /** true 表示该用户必须先完成基线测评（今日训练与首页任务卡指向 /baseline） */
  required: boolean;
  /** 上架基线题总数（预期 2） */
  total: number;
  /** 已提交终答的基线题去重数（T36：流程推进口径） */
  answeredCount: number;
  /** 已评分完成的基线题去重数（完成判定口径） */
  doneCount: number;
  /** 按固定顺序的下一道待作答基线题（全部完成/全部已作答待评分/不需要基线时为 null） */
  nextQuestion: Question | null;
  /** 基线完成时间（user_profiles.baseline_completed_at；无画像行或未完成为 null） */
  completedAt: Date | null;
  /** 已提交终答且未评分的基线会话 id（T36：路由层补触发评分用，属服务端内部信息，不下发前端） */
  pendingScoringSessionIds: string[];
  /** 逐题进度视图（T27 切片 3：orderIndex 即序列位次；加深题触发前不出现在 items） */
  items: BaselineProgressItem[];
  /** 评分/加深判定进行中（序列内存在已作答未评分会话；T27「判定中」最薄表达，供续测横幅提示） */
  scoringPending: boolean;
  /** 完成后八维点亮预览（BR-6 未知态为 null）；未完成为 null */
  dimensionPreview: DimensionPreviewItem[] | null;
}

async function serializable<T>(db: DbClient, work: (tx: DbClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction((tx) => work(tx as DbClient), { isolationLevel: "Serializable" });
    } catch (error) {
      if (attempt >= 2 || (error as { code?: string }).code !== "P2034") throw error;
    }
  }
}

/** 读取基线状态；全部评完时幂等补写完成标记（以已评分会话为事实源，标记缺失可自愈） */
export async function getBaselineStatus(
  db: DbClient,
  userId: string,
  deps: BaselineStatusDeps = {},
): Promise<BaselineStatus> {
  if (!deps.repository && typeof db.$transaction === "function") {
    return serializable(db, (tx) => getBaselineStatus(tx, userId, { ...deps, repository: createPrismaBaselineRepository(tx), lockDeepens: true }));
  }
  const repository = deps.repository ?? createPrismaBaselineRepository(db);
  const questions = await repository.listPublishedBaselineQuestions();
  const totalPool = questions.length;
  if (totalPool === 0) {
    return {
      required: false,
      total: 0,
      answeredCount: 0,
      doneCount: 0,
      nextQuestion: null,
      completedAt: null,
      pendingScoringSessionIds: [],
      items: [],
      scoringPending: false,
      dimensionPreview: null,
    };
  }

  // 题序（T27 切片 2）：八维标注齐全 → plan 序列（主题 + 已触发加深题）；
  // 兼容桥：plan 为空（存量无标注基线题）→ V1 id 升序语义
  const sessions = await repository.listBaselineSessionsForCount(userId, questions.map((question) => question.id));
  const dimensionById = new Map(questions.map((question) => [question.id, primaryDimensionOf(question)]));
  const anchored = new Map<string, string>();
  for (const session of sessions) {
    const dimension = dimensionById.get(session.questionId);
    const hasEvidence = session.baselineActivatedAt != null || session.firstAnswer != null || session.finalSubmittedAt != null || session.scoredAt != null || session.state === "answering" || session.state === "followup" || (session.hintCount ?? 0) > 0 || (session.followupHintCount ?? 0) > 0;
    if (dimension && hasEvidence && !anchored.has(dimension)) anchored.set(dimension, session.questionId);
  }
  const plan = planBaselineItems(questions, ABILITY_DIMENSIONS, anchored);
  const legacy = plan.length === 0;
  const threshold = resolveDeepenThreshold(deps);
  let sequence: SequenceItem[];
  if (legacy) {
    sequence = questions.map((question) => ({ question, isDeepen: false }));
  } else {
    // 加深判定事实源：各维主题已评分会话的 Score.confidence（同一次评分运行各维度行同值，任取一条）
    const confidenceRows = await repository.listBaselineConfidences(
      userId,
      plan.map((item) => item.primary.id),
    );
    const confidenceByPrimary = new Map(confidenceRows.map((row) => [row.questionId, row.confidence]));
    const confidenceByDimension = new Map<string, number | null>();
    for (const item of plan) {
      const confidence = confidenceByPrimary.get(item.primary.id);
      if (confidence !== undefined) confidenceByDimension.set(item.dimension, confidence);
    }
    const lockedIds = new Set(sessions.map((session) => session.questionId));
    const locked = plan.filter((item) => item.deepenCandidate && lockedIds.has(item.deepenCandidate.id))
      .map((item) => ({ dimension: item.dimension, questionId: item.deepenCandidate!.id }));
    const decisions = [...locked, ...decideDeepenQuestions({ plan, confidenceByDimension, threshold, maxDeepenDimensions: plan.length })
      .filter((item) => !locked.some((existing) => existing.dimension === item.dimension))
      .slice(0, Math.max(0, 4 - locked.length))];
    if (deps.lockDeepens && !(await repository.findBaselineCompletedAt(userId))) {
      for (const decision of decisions) {
        if (!lockedIds.has(decision.questionId)) {
          await repository.createBaselineSession(userId, decision.questionId, todayUtc());
        }
      }
    }
    const deepenByDimension = new Map(decisions.map((decision) => [decision.dimension, decision.questionId]));
    sequence = plan.flatMap((item) => {
      const items: SequenceItem[] = [{ question: item.primary, isDeepen: false }];
      // 加深题紧随同维主题（首题评分完成后出现在序列中）
      if (item.deepenCandidate && deepenByDimension.get(item.dimension) === item.deepenCandidate.id) {
        items.push({ question: item.deepenCandidate, isDeepen: true });
      }
      return items;
    });
  }

  const completedAtBefore = await repository.findBaselineCompletedAt(userId);

  // 双计数按序列内题目去重（total 语义 = 主题数 + 已触发加深数）
  const sequenceIds = new Set(sequence.map((item) => item.question.id));
  const answeredIds = new Set(
    sessions
      .filter((session) => session.finalSubmittedAt !== null && sequenceIds.has(session.questionId))
      .map((s) => s.questionId),
  );
  const scoredIds = new Set(
    sessions
      .filter((session) => session.scoredAt !== null && sequenceIds.has(session.questionId))
      .map((s) => s.questionId),
  );
  const answeredCount = answeredIds.size;
  const doneCount = scoredIds.size;
  const total = sequence.length;
  const pendingScoringSessionIds = sessions
    .filter(
      (session) =>
        session.finalSubmittedAt !== null &&
        session.scoredAt === null &&
        sequenceIds.has(session.questionId),
    )
    .map((session) => session.id);
  const allScored = (legacy || plan.length === ABILITY_DIMENSIONS.length) && doneCount >= total;

  let completedAt = completedAtBefore;
  if (allScored && completedAt === null) {
    // 幂等写入：守卫 baselineCompletedAt: null，并发/重复调用只有首次生效
    const marker = new Date();
    const written = await repository.markBaselineCompleted(userId, marker);
    if (written > 0) {
      completedAt = marker;
    } else {
      // 并发另一方已写入：回读以其为准；无画像行时保持 null（不影响 required 判定）
      completedAt = await repository.findBaselineCompletedAt(userId);
    }
  }

  const done = allScored || completedAt !== null;
  // T36 + 断点续测：下一题是序列内第一道未提交终答的题；全部已作答未评完时为 null（门禁边界）
  const unfinished = sessions.filter((session) => session.finalSubmittedAt === null && sequenceIds.has(session.questionId));
  const active = unfinished.find((session) => session.baselineActivatedAt != null)
    ?? unfinished.find((session) => session.firstAnswer != null || session.state === "answering" || session.state === "followup" || (session.hintCount ?? 0) > 0 || (session.followupHintCount ?? 0) > 0);
  const nextQuestion = done
    ? null
    : (sequence.find((item) => item.question.id === active?.questionId)?.question
      ?? sequence.find((item) => !answeredIds.has(item.question.id))?.question ?? null);

  // 逐题进度（T27 切片 3）：state 口径——scored=已评分；active=进行中（已作答待评分，
  // 含评分/加深「判定中」窗口；或当前待作答第一题）；pending=未到
  const dimensionByQuestionId = new Map<string, string | null>();
  if (legacy) {
    for (const item of sequence) dimensionByQuestionId.set(item.question.id, primaryDimensionOf(item.question));
  } else {
    for (const item of plan) {
      dimensionByQuestionId.set(item.primary.id, item.dimension);
      if (item.deepenCandidate) dimensionByQuestionId.set(item.deepenCandidate.id, item.dimension);
    }
  }
  const items: BaselineProgressItem[] = sequence.map((item, orderIndex) => {
    const scored = scoredIds.has(item.question.id);
    const answered = answeredIds.has(item.question.id);
    return {
      questionId: item.question.id,
      dimension: dimensionByQuestionId.get(item.question.id) ?? null,
      orderIndex,
      state: scored ? "scored" : answered || nextQuestion?.id === item.question.id ? "active" : "pending",
      isDeepen: item.isDeepen,
    };
  });

  // 完成后八维点亮预览（BR-6：维度分 = 历史有效分简单平均；无记录维度为未知 null）
  let dimensionPreview: DimensionPreviewItem[] | null = null;
  if (done) {
    const scores = await repository.listAbilityScores(userId);
    const byDimension = new Map(scores.map((row) => [row.dimension, row.currentScore]));
    dimensionPreview = ABILITY_DIMENSIONS.map((dimension) => ({
      dimension,
      effectiveScore: byDimension.get(dimension) ?? null,
    }));
  }

  return {
    required: !done,
    total,
    answeredCount,
    doneCount,
    nextQuestion,
    completedAt,
    pendingScoringSessionIds,
    items,
    scoringPending: pendingScoringSessionIds.length > 0,
    dimensionPreview,
  };
}

export interface BaselineSessionResult {
  session: TrainingSession;
  question: Question;
  status: BaselineStatus;
}

/**
 * 获取或创建当前基线题的会话（按 {userId, questionId} 幂等复用，中断后可恢复）。
 * 目标题即 getBaselineStatus 的 nextQuestion（T36 起按「未提交终答」推进，不等评分）；
 * 不需要基线或全部已作答待评分（nextQuestion=null）时抛 BaselineError(BASELINE_NOT_REQUIRED)，
 * 由调用方回退日常训练（today 路由对该边界另行返回 409 BASELINE_SCORING_PENDING）。
 */
export async function getOrCreateBaselineSession(
  db: DbClient,
  userId: string,
  deps: BaselineStatusDeps = {},
): Promise<BaselineSessionResult> {
  if (!deps.repository && typeof db.$transaction === "function") {
    return serializable(db, (tx) => getOrCreateBaselineSession(tx, userId, { ...deps, repository: createPrismaBaselineRepository(tx), lockDeepens: true }));
  }
  const repository = deps.repository ?? createPrismaBaselineRepository(db);
  const status = await getBaselineStatus(db, userId, { ...deps, repository });
  if (!status.required || !status.nextQuestion) {
    throw new BaselineError(CODES.BASELINE_NOT_REQUIRED, 409, "能力基线测评已完成或暂不需要");
  }
  const questionId = status.nextQuestion.id;

  const existing = await repository.findOwnedSession(userId, questionId);
  const session = existing ?? await repository.createBaselineSession(userId, questionId, todayUtc());
  if (deps.lockDeepens) {
    await repository.activateBaselineSession(userId, session.id, new Date());
    const activated = await repository.findOwnedSessionOrThrow(userId, questionId);
    return { session: activated, question: activated.question, status };
  }
  return { session, question: existing?.question ?? status.nextQuestion, status };
}
