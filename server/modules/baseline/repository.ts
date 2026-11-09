import type { PrismaClient, Question, TrainingSession } from "@prisma/client";

/**
 * 基线测评仓储（T27 切片 1：server/modules/baseline 分层补齐，对齐 auth 模块形态）。
 * 题库 / 会话 / 画像查询全部下沉于此；service.ts 只依赖本接口，
 * 业务语义（双计数口径、守卫式完成标记、幂等复用）不变。
 */

/** 双计数（T36 / D38）事实源行：一次查询同时取 scoredAt / finalSubmittedAt */
export interface BaselineSessionCountRow {
  id: string;
  questionId: string;
  scoredAt: Date | null;
  finalSubmittedAt: Date | null;
  baselineActivatedAt?: Date | null;
  state?: TrainingSession["state"];
  firstAnswer?: string | null;
  hintCount?: number;
  followupHintCount?: number;
}

export interface BaselineRepository {
  /** 上架基线题池：kind=baseline 且 status=published，按 id 升序（内容侧约定候选顺序） */
  listPublishedBaselineQuestions(): Promise<Question[]>;
  /** user_profiles.baseline_completed_at（无画像行返回 null） */
  findBaselineCompletedAt(userId: string): Promise<Date | null>;
  /** 该用户在指定基线题上的已作答/已评分会话（双计数事实源） */
  listBaselineSessionsForCount(userId: string, questionIds: string[]): Promise<BaselineSessionCountRow[]>;
  /**
   * 各基线题已评分会话的置信度（Score.confidence；BR-V2-6 加深判定事实源）。
   * 同一次评分运行对该题各维度行写入同一置信度，故每题任取一条即可（按 id 升序首条）。
   */
  listBaselineConfidences(
    userId: string,
    questionIds: string[],
  ): Promise<{ questionId: string; confidence: number | null }[]>;
  /** 用户各维度当前能力分（ability_profiles；完成后八维点亮预览事实源，BR-6：null = 未知） */
  listAbilityScores(userId: string): Promise<{ dimension: string; currentScore: number | null }[]>;
  /** 守卫式写入完成标记：仅 baselineCompletedAt 为 null 时生效；返回受影响行数（并发幂等） */
  markBaselineCompleted(userId: string, marker: Date): Promise<number>;
  /** 按 {userId, questionId} 查已存在会话（幂等复用；含 question） */
  findOwnedSession(
    userId: string,
    questionId: string,
  ): Promise<(TrainingSession & { question: Question }) | null>;
  /** 并发首次进入兜底：回读另一请求已创建的会话（含 question） */
  findOwnedSessionOrThrow(
    userId: string,
    questionId: string,
  ): Promise<TrainingSession & { question: Question }>;
  activateBaselineSession(userId: string, sessionId: string, activatedAt: Date): Promise<void>;
  /** 创建基线会话（isExtra=true，不占每日一题槽位，D19） */
  createBaselineSession(userId: string, questionId: string, date: Date): Promise<TrainingSession>;
}

export function createPrismaBaselineRepository(db: PrismaClient): BaselineRepository {
  return {
    listPublishedBaselineQuestions: () =>
      db.question.findMany({
        where: { kind: "baseline", status: "published" },
        orderBy: { id: "asc" },
      }),
    findBaselineCompletedAt: async (userId) => {
      const profile = await db.userProfile.findUnique({
        where: { userId },
        select: { baselineCompletedAt: true },
      });
      return profile?.baselineCompletedAt ?? null;
    },
    listBaselineSessionsForCount: (userId, questionIds) =>
      db.trainingSession.findMany({
        where: {
          userId,
          questionId: { in: questionIds },
        },
        select: { id: true, questionId: true, scoredAt: true, finalSubmittedAt: true, baselineActivatedAt: true, state: true, firstAnswer: true, hintCount: true, followupHintCount: true },
        orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      }),
    listBaselineConfidences: async (userId, questionIds) => {
      if (questionIds.length === 0) return [];
      const rows = await db.score.findMany({
        where: { session: { userId, questionId: { in: questionIds } } },
        select: { confidence: true, session: { select: { questionId: true } } },
        orderBy: { id: "asc" },
      });
      const byQuestion = new Map<string, number | null>();
      for (const row of rows) {
        if (!byQuestion.has(row.session.questionId)) {
          byQuestion.set(row.session.questionId, row.confidence);
        }
      }
      return [...byQuestion.entries()].map(([questionId, confidence]) => ({
        questionId,
        confidence,
      }));
    },
    listAbilityScores: (userId) =>
      db.abilityProfile.findMany({
        where: { userId },
        select: { dimension: true, currentScore: true },
      }),
    markBaselineCompleted: async (userId, marker) => {
      const result = await db.userProfile.updateMany({
        where: { userId, baselineCompletedAt: null },
        data: { baselineCompletedAt: marker },
      });
      return result.count;
    },
    findOwnedSession: (userId, questionId) =>
      db.trainingSession.findFirst({
        where: { userId, questionId },
        include: { question: true },
        orderBy: { startedAt: "asc" },
      }),
    findOwnedSessionOrThrow: (userId, questionId) =>
      db.trainingSession.findFirstOrThrow({
        where: { userId, questionId },
        include: { question: true },
        orderBy: { startedAt: "asc" },
      }),
    activateBaselineSession: async (userId, sessionId, activatedAt) => {
      await db.trainingSession.updateMany({ where: { id: sessionId, userId, baselineActivatedAt: null }, data: { baselineActivatedAt: activatedAt } });
    },
    createBaselineSession: (userId, questionId, date) =>
      db.trainingSession.create({
        // T29：基线题会话透传 sourceType=baseline（P3 公共前置；isExtra 语义不变）
        data: { userId, questionId, date, isExtra: true, state: "reading", sourceType: "baseline" },
      }),
  };
}
