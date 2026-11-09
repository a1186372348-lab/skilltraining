import { z } from "zod";

import type { TrainingPlan } from "@prisma/client";

import type { WeeklyReviewResult } from "./service";

/**
 * 周期训练计划的 API 契约（T29 / F5；切片 4 路由使用，本切片先定契约）。
 * FR-10 出口：计划视图只含展示字段，不下发任何 Rubric / 提示树。
 */

/** 计划视图（大厅计划条 / 首页悬挂卡 / 计划详情共用） */
export const trainingPlanViewSchema = z.object({
  id: z.string(),
  /** 周一（ISO 日期，@db.Date 口径） */
  weekStartDate: z.string(),
  /** 主攻维度（8 个一级维度之一） */
  focusDimension: z.string(),
  /** 生成时该维当前分 */
  startScore: z.number(),
  /** 目标分 = min(100, 当前分 + 10)（D35） */
  targetScore: z.number(),
  status: z.enum(["active", "rejected", "completed"]),
  /** 选择理由（模板文案，含维度名与当前分） */
  reason: z.string(),
  createdAt: z.string(),
});

export type TrainingPlanView = z.infer<typeof trainingPlanViewSchema>;

/** 计划进度聚合（本周 plan 题） */
export const planProgressSchema = z.object({
  /** 本周已评分的计划题会话数 */
  scoredCount: z.number().int().nonnegative(),
  /** 按实际评分完成日期去重的完成天数 */
  completedDays: z.number().int().nonnegative(),
  completedDates: z.array(z.string()).optional(),
});

export type PlanProgress = z.infer<typeof planProgressSchema>;

export const reviewSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  scoredCount: z.number().int().nonnegative(),
  completedDays: z.number().int().nonnegative(),
  completedDates: z.array(z.string()),
  startScore: z.number(),
  latestScore: z.number().nullable(),
  scoreChange: z.number().nullable(),
});
export type ReviewSnapshot = z.infer<typeof reviewSnapshotSchema>;
/** 周回顾视图（蓝图 §2.4：周日生成，完成天数 + 主攻维度有效分变化） */
export const weeklyReviewSchema = z.object({
  plan: trainingPlanViewSchema,
  scoredCount: z.number().int().nonnegative(),
  completedDays: z.number().int().nonnegative(),
  /** 生成时主攻维度分（计划创建快照） */
  startScore: z.number(),
  /** 周日最新有效分（画像当前分，与 ability.ts 有效分事实源口径一致） */
  latestScore: z.number().nullable(),
  /** 有效分变化 = latestScore − startScore（未知时为 null） */
  scoreChange: z.number().nullable(),
});

export type WeeklyReviewView = z.infer<typeof weeklyReviewSchema>;

/* ============================== 映射（服务层 → API 视图，schema.parse 收口） ============================== */

/** 计划行 → 视图（weekStartDate 按 ISO 日期下发；createdAt 按 ISO 时间戳下发） */
export function toTrainingPlanView(plan: TrainingPlan): TrainingPlanView {
  return trainingPlanViewSchema.parse({
    id: plan.id,
    weekStartDate: plan.weekStartDate.toISOString().slice(0, 10),
    focusDimension: plan.focusDimension,
    startScore: plan.startScore,
    targetScore: plan.targetScore,
    status: plan.status,
    reason: plan.reason,
    createdAt: plan.createdAt.toISOString(),
  });
}

/** 周回顾结果 → 视图 */
export function toWeeklyReviewView(result: WeeklyReviewResult): WeeklyReviewView {
  return weeklyReviewSchema.parse({
    plan: toTrainingPlanView(result.plan),
    scoredCount: result.scoredCount,
    completedDays: result.completedDays,
    startScore: result.startScore,
    latestScore: result.latestScore,
    scoreChange: result.scoreChange,
  });
}
