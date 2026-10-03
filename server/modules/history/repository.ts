import type { PrismaClient } from "@prisma/client";

import type { HistorySessionDetailRow, HistorySessionListRow } from "./view";

/**
 * 训练历史的数据访问（training_sessions / hint_events / scores / session_feedback / questions）。
 * 全部查询按 user_id 收窄：历史仅返回当前用户记录（US-009）。
 */

export async function countHistorySessions(
  db: PrismaClient,
  userId: string,
): Promise<number> {
  return db.trainingSession.count({ where: { userId } });
}

/**
 * 列表页一页：按训练日期倒序（同日按进入时间、id 倒序兜底，保证分页顺序稳定）。
 * 只 select 列表装配所需字段；rubric / hintTree 不查询、不出库（FR-10）。
 */
export async function findHistorySessionPage(
  db: PrismaClient,
  userId: string,
  page: number,
  pageSize: number,
): Promise<HistorySessionListRow[]> {
  return db.trainingSession.findMany({
    where: { userId },
    orderBy: [{ date: "desc" }, { startedAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: {
      id: true,
      date: true,
      isExtra: true,
      state: true,
      question: { select: { caseTitle: true, abilityTags: true } },
      scores: { select: { dimension: true, effectiveScore: true } },
    },
  });
}

/**
 * 详情回放一行：携带六区装配所需的全部关联。
 * 提示事件按请求时间升序（回放"层数 + 时间"）；题目同样不取 rubric / hintTree（FR-10）。
 */
export async function findHistorySessionDetail(
  db: PrismaClient,
  sessionId: string,
): Promise<HistorySessionDetailRow | null> {
  return db.trainingSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      userId: true,
      date: true,
      isExtra: true,
      state: true,
      firstAnswer: true,
      firstSubmittedAt: true,
      finalAnswer: true,
      finalSubmittedAt: true,
      hintCount: true,
      followups: true,
      question: {
        select: {
          caseTitle: true,
          caseBackground: true,
          mainQuestion: true,
          abilityTags: true,
          difficulty: true,
        },
      },
      hintEvents: {
        orderBy: [{ requestedAt: "asc" }, { layer: "asc" }],
        select: { layer: true, requestedAt: true },
      },
      scores: {
        select: {
          dimension: true,
          rawScore: true,
          hintCount: true,
          coefficient: true,
          effectiveScore: true,
          diagnosisText: true,
        },
      },
      feedback: { select: { topIssueText: true, nextFocusText: true } },
    },
  });
}
