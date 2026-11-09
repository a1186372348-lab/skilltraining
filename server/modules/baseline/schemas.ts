import { z } from "zod";

import type { BaselineStatus } from "./service";

/**
 * 基线测评 status 响应契约（T27 切片 1：自路由内联形状抽出，对齐 auth/schemas.ts 形态）。
 * GET /api/training/baseline 的出口（FR-10 白名单：只下发题目 id 与标题，
 * Rubric / 提示树 / 待评分会话 id 绝不下发）；required / completedAt 语义保持兼容。
 */
export const baselineStatusResponseSchema = z.object({
  /** true 表示该用户必须先完成基线测评（今日训练与首页任务卡指向 /baseline） */
  required: z.boolean(),
  /** 上架基线题总数 */
  total: z.number().int().nonnegative(),
  /** 已提交终答的基线题去重数（T36：流程推进口径） */
  answeredCount: z.number().int().nonnegative(),
  /** 已评分完成的基线题去重数（完成判定口径） */
  doneCount: z.number().int().nonnegative(),
  /** 下一道待作答基线题（FR-10：仅 id 与标题；完成/待评分/不需要基线时为 null） */
  nextQuestion: z.object({ id: z.string(), caseTitle: z.string() }).nullable(),
  /** 基线完成时间（ISO 字符串；未完成为 null） */
  completedAt: z.string().nullable(),
});

export type BaselineStatusResponse = z.infer<typeof baselineStatusResponseSchema>;

/**
 * 服务层状态 → 响应载荷映射（FR-10 出口防线：pendingScoringSessionIds 等
 * 服务端内部信息在此天然不落；schema.parse 对受控数据纯校验，不改变响应形状）。
 */
export function toBaselineStatusResponse(status: BaselineStatus): BaselineStatusResponse {
  return baselineStatusResponseSchema.parse({
    required: status.required,
    total: status.total,
    answeredCount: status.answeredCount,
    doneCount: status.doneCount,
    nextQuestion: status.nextQuestion
      ? { id: status.nextQuestion.id, caseTitle: status.nextQuestion.caseTitle }
      : null,
    completedAt: status.completedAt?.toISOString() ?? null,
  });
}

/* ============================== 逐题进度视图（T27 切片 3） ============================== */

/** 逐题进度项（FR-10 白名单：只含下列字段；题目 rubric/hintTree/forbiddenLeaks/案例材料绝不下发） */
export const baselineProgressItemSchema = z.object({
  questionId: z.string(),
  /** 主测维度（兼容桥存量无标注题为 null） */
  dimension: z.string().nullable(),
  orderIndex: z.number().int().nonnegative(),
  /** pending=未到 / active=进行中 / scored=已评分 */
  state: z.enum(["pending", "active", "scored"]),
  /** 加深题标记（confidence 触发追加；未触发不出现在 items） */
  isDeepen: z.boolean(),
});

/** 断点续测信息（切片 4 横幅数据源） */
export const baselineResumeSchema = z.object({
  /** 是否存在进行中进度（已开始未完成） */
  hasInProgress: z.boolean(),
  /** 当前应继续的题（全部已作答待评分/不需要基线时为 null） */
  questionId: z.string().nullable(),
  dimension: z.string().nullable(),
  /**
   * 评分/加深判定进行中（T27「判定中」最薄表达：异步评分 30~60 秒，
   * 加深题触发前的判定窗口——横幅据此提示「评分/判定进行中」而非死等）
   */
  scoringPending: z.boolean(),
});

/** 完成后八维点亮预览项（BR-6：effectiveScore 为 null = 未知，不落 0 分） */
export const dimensionPreviewItemSchema = z.object({
  dimension: z.string(),
  effectiveScore: z.number().nullable(),
});

/**
 * 逐题进度响应契约（T27 切片 3 新增独立契约——在 status 契约上扩展，
 * required / total / doneCount / completedAt 兼容字段原样保留，既有调用方不破）。
 */
export const baselineProgressResponseSchema = baselineStatusResponseSchema.extend({
  items: z.array(baselineProgressItemSchema),
  resume: baselineResumeSchema,
  /** 完成后八维点亮预览；未完成为 null */
  dimensionPreview: z.array(dimensionPreviewItemSchema).nullable(),
});

export type BaselineProgressResponse = z.infer<typeof baselineProgressResponseSchema>;

/**
 * 服务层状态 → 逐题进度载荷（FR-10 出口防线：resume 从既有字段派生，
 * pendingScoringSessionIds 等内部信息天然不落；item 多余键经 schema strip 剥除）。
 */
export function toBaselineProgressResponse(status: BaselineStatus): BaselineProgressResponse {
  const nextDimension = status.nextQuestion
    ? (status.items.find((item) => item.questionId === status.nextQuestion!.id)?.dimension ?? null)
    : null;
  return baselineProgressResponseSchema.parse({
    ...toBaselineStatusResponse(status),
    items: status.items,
    resume: {
      hasInProgress: status.required && status.answeredCount > 0,
      questionId: status.nextQuestion?.id ?? null,
      dimension: nextDimension,
      scoringPending: status.scoringPending,
    },
    dimensionPreview: status.dimensionPreview,
  });
}
