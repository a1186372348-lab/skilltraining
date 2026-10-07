import type { PrismaClient } from "@prisma/client";

/**
 * 评分完成全局通知的服务端查询（T24 / Prd.md D26）。
 *
 * 两类可通知项（仅当前用户、仅非基线会话——基线有自己的完成体验，D26⑦）：
 * - scored：终答已评分（state=scored）且 scoredAt 在近 7 天内，倒序至多 5 条；
 * - stuck：终答提交超 5 分钟仍未评分（state 停留 followup，MiMo 波动兜底，D26⑥），
 *   倒序至多 3 条——用户点击进反馈页即懒重触发评分（T07 恢复通道）。
 *
 * 轻量 DB 查询（每 10 秒轮询一次），不接 AI 端点限流（参照 /api/training/today）。
 */

/** scored 回看窗口：7 天 */
export const SCORED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** stuck 判定阈值：终答提交超过 5 分钟仍未评分 */
export const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
/** 两类通知各自的返回上限 */
export const SCORED_LIMIT = 5;
export const STUCK_LIMIT = 3;

export type ScoreNotificationKind = "scored" | "stuck";

export interface ScoreNotificationItem {
  sessionId: string;
  /** 案例名口径与训练历史列表一致：关联题目的 case_title */
  caseTitle: string;
  kind: ScoreNotificationKind;
  /** ISO 时间：scored 取 scoredAt，stuck 取 finalSubmittedAt */
  occurredAt: string;
}

export interface ScoreNotificationsView {
  items: ScoreNotificationItem[];
}

/** 读取当前用户的可通知项：scored 在前、stuck 在后，各自按发生时间倒序 */
export async function getScoreNotifications(
  db: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<ScoreNotificationsView> {
  const [scoredRows, stuckRows] = await Promise.all([
    db.trainingSession.findMany({
      where: {
        userId,
        state: "scored",
        scoredAt: { gte: new Date(now.getTime() - SCORED_WINDOW_MS) },
        question: { kind: { not: "baseline" } },
      },
      orderBy: { scoredAt: "desc" },
      take: SCORED_LIMIT,
      select: { id: true, scoredAt: true, question: { select: { caseTitle: true } } },
    }),
    db.trainingSession.findMany({
      where: {
        userId,
        state: "followup",
        // lt 比较天然排除 finalSubmittedAt 为 null 的进行中会话
        finalSubmittedAt: { lt: new Date(now.getTime() - STUCK_THRESHOLD_MS) },
        question: { kind: { not: "baseline" } },
      },
      orderBy: { finalSubmittedAt: "desc" },
      take: STUCK_LIMIT,
      select: { id: true, finalSubmittedAt: true, question: { select: { caseTitle: true } } },
    }),
  ]);

  const scored: ScoreNotificationItem[] = scoredRows.flatMap((row) =>
    row.scoredAt
      ? [
          {
            sessionId: row.id,
            caseTitle: row.question.caseTitle,
            kind: "scored" as const,
            occurredAt: row.scoredAt.toISOString(),
          },
        ]
      : [],
  );
  const stuck: ScoreNotificationItem[] = stuckRows.flatMap((row) =>
    row.finalSubmittedAt
      ? [
          {
            sessionId: row.id,
            caseTitle: row.question.caseTitle,
            kind: "stuck" as const,
            occurredAt: row.finalSubmittedAt.toISOString(),
          },
        ]
      : [],
  );
  return { items: [...scored, ...stuck] };
}
