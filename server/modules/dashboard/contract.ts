import { z } from "zod";

/**
 * 首页仪表盘数据契约（T08 / US-002，Prd.md 2.3 页面 P1）。
 *
 * 四个卡片数据独立装配、各自可空：null 即空态（新用户无数据，或单卡加载失败
 * 降级——失败与回滚约定：单卡失败不拖垮整页）。
 * zod schema 在路由出口做边界校验（快速失败，绝不信任装配产出）。
 */

const dateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** 本周分段进度的一段（周一 ~ 周日） */
export const weekDaySchema = z.object({
  dateKey: dateKeySchema,
  /** 周几：1=周一 … 7=周日 */
  weekday: z.number().int().min(1).max(7),
  /** 当天是否有已提交终答的训练 */
  trained: z.boolean(),
  isToday: z.boolean(),
  isFuture: z.boolean(),
});

/** 统计条：连续训练天数 + 本周 n/7 */
export const statsCardSchema = z.object({
  streakDays: z.number().int().min(0),
  weekTrainedCount: z.number().int().min(0).max(7),
  weekDays: z.array(weekDaySchema).length(7),
});

/** 今日任务主卡（复用每日一题会话；completed 时前端展示「再练一题」） */
export const todayTaskCardSchema = z.object({
  sessionId: z.string(),
  state: z.enum(["reading", "answering", "followup", "scored"]),
  /** 已提交终答（或已评分）即视为今日已完成 */
  completed: z.boolean(),
  caseTitle: z.string(),
  mainQuestion: z.string(),
  /** 训练重点：本题能力标签（BR-1，本次仅按它们评分） */
  abilityTags: z.array(z.string()),
  focusText: z.string(),
  /** 「为什么是它」占位文案（真实自适应理由 T11 接入） */
  whyText: z.string(),
});

/** 能力总览条形（已观测维度） */
export const abilityBarSchema = z.object({
  dimension: z.string(),
  /** 展示分：当前分取整（0~100 量纲与评分一致） */
  score: z.number(),
  trend: z.enum(["上升", "稳定", "下降"]).nullable(),
});

/** 能力总览：已观测条形 + 未观测「待解锁」虚态 + n/8 */
export const abilityOverviewSchema = z.object({
  unlockedCount: z.number().int().min(0),
  totalCount: z.number().int(),
  observed: z.array(abilityBarSchema),
  unobserved: z.array(z.string()),
});

/** 最近一条诊断（session_feedback.top_issue_text 截断展示） */
export const latestDiagnosisSchema = z.object({
  sessionId: z.string(),
  text: z.string(),
  dateKey: dateKeySchema,
});

export const dashboardViewSchema = z.object({
  todayDateKey: dateKeySchema,
  stats: statsCardSchema.nullable(),
  todayTask: todayTaskCardSchema.nullable(),
  ability: abilityOverviewSchema.nullable(),
  latestDiagnosis: latestDiagnosisSchema.nullable(),
});

export type WeekDayView = z.infer<typeof weekDaySchema>;
export type StatsCardData = z.infer<typeof statsCardSchema>;
export type TodayTaskCardData = z.infer<typeof todayTaskCardSchema>;
export type AbilityBarView = z.infer<typeof abilityBarSchema>;
export type AbilityOverviewData = z.infer<typeof abilityOverviewSchema>;
export type LatestDiagnosisData = z.infer<typeof latestDiagnosisSchema>;
export type DashboardView = z.infer<typeof dashboardViewSchema>;
