import { Prisma, type PrismaClient, type TrainingPlan, type TrainingPlanStatus } from "@prisma/client";

/**
 * 周期训练计划仓储（T29 / F5）：training_plans 表与计划会话聚合的数据访问边界。
 * 业务逻辑只依赖 PlanningRepository 接口（测试用内存桩，生产用 Prisma 实现）。
 */

import type { ReviewSnapshot } from "./schemas";

/** 本周计划会话（进度聚合事实源）：sourceType=plan 且已评分（scoredAt 非空） */
export interface PlanScoredSessionRow {
  /** 实际评分完成时间（按 UTC 日期去重） */
  scoredAt: Date;
}

export interface PlanningRepository {
  /** 按本人和计划编号重读，不能信任调用方持有的旧计划。 */
  findPlanById(userId: string, id: string): Promise<TrainingPlan | null>;
  /** 按周（周一）查计划（懒生成幂等读取） */
  findPlanByWeek(userId: string, weekStartDate: Date): Promise<TrainingPlan | null>;
  /** 最近一期计划（周回顾目标；无则 null） */
  findLatestPlan(userId: string): Promise<TrainingPlan | null>;
  /** 创建计划（并发首访撞 @@unique 由 service 层捕获回读） */
  createPlan(data: {
    userId: string;
    weekStartDate: Date;
    focusDimension: string;
    startScore: number;
    targetScore: number;
    reason: string;
  }): Promise<TrainingPlan>;
  /** 状态推进（active/rejected/completed；幂等由 service 层先读后写保证） */
  updatePlanStatus(id: string, status: TrainingPlanStatus): Promise<TrainingPlan>;
  changePlanStatus(userId: string, id: string, expected: TrainingPlanStatus, status: TrainingPlanStatus): Promise<TrainingPlan>;
  /** 指定计划在本周实际评分完成的会话 */
  listPlanScoredSessions(userId: string, weekStartDate: Date, planId: string, cutoff?: Date): Promise<PlanScoredSessionRow[]>;
  findReviewablePlan(userId: string, latestWeek: Date): Promise<TrainingPlan | null>;
  averageScoreUntil(userId: string, dimension: string, cutoff: Date): Promise<number | null>;
  saveReviewSnapshot(userId: string, plan: TrainingPlan, snapshot: ReviewSnapshot): Promise<TrainingPlan>;
}

type PlanningDb = PrismaClient | Prisma.TransactionClient;

export function createPrismaPlanningRepository(db: PlanningDb): PlanningRepository {
  return {
    findPlanById: (userId, id) => db.trainingPlan.findFirst({ where: { id, userId } }),
    findPlanByWeek: (userId, weekStartDate) =>
      db.trainingPlan.findUnique({
        where: { userId_weekStartDate: { userId, weekStartDate } },
      }),
    findLatestPlan: (userId) =>
      db.trainingPlan.findFirst({
        where: { userId },
        orderBy: { weekStartDate: "desc" },
      }),
    createPlan: (data) => db.trainingPlan.create({ data }),
    updatePlanStatus: (id, status) => db.trainingPlan.update({ where: { id }, data: { status } }),
    findReviewablePlan: (userId, latestWeek) => db.trainingPlan.findFirst({
      where: { userId, weekStartDate: { lte: latestWeek } }, orderBy: { weekStartDate: "desc" },
    }),
    averageScoreUntil: async (userId, dimension, cutoff) => {
      const result = await db.score.aggregate({
        where: { dimension, session: { userId, scoredAt: { lt: cutoff } } },
        _avg: { effectiveScore: true },
      });
      return result._avg.effectiveScore === null ? null : Math.round(result._avg.effectiveScore * 100) / 100;
    },
    saveReviewSnapshot: (userId, plan, snapshot) => {
      const save = async (tx: Prisma.TransactionClient) => {
        const saved = await tx.trainingPlan.updateMany({
          where: { id: plan.id, userId, reviewSnapshot: { equals: Prisma.DbNull } }, data: { reviewSnapshot: snapshot },
        });
        if (saved.count) await tx.trainingPlan.updateMany({
          where: { id: plan.id, userId, status: "active" }, data: { status: "completed" },
        });
        return tx.trainingPlan.findFirstOrThrow({ where: { id: plan.id, userId } });
      };
      return "$transaction" in db ? db.$transaction(save) : save(db);
    },
    changePlanStatus: async (userId, id, expected, status) => {
      await db.trainingPlan.updateMany({ where: { id, userId, status: expected }, data: { status } });
      return db.trainingPlan.findFirstOrThrow({ where: { id, userId } });
    },
    listPlanScoredSessions: (userId, weekStartDate, planId, cutoff) => {
      const weekEnd = new Date(weekStartDate);
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
      return db.trainingSession.findMany({
        where: {
          userId,
          OR: [
            { sourceType: "plan", sourceId: planId },
            { sourceType: "pack", linkedPlanId: planId },
          ],
          scoredAt: { gte: weekStartDate, lt: cutoff && cutoff < weekEnd ? cutoff : weekEnd },
        },
        select: { scoredAt: true },
      }).then((rows) => rows.filter((row): row is { scoredAt: Date } => row.scoredAt !== null));
    },
  };
}
