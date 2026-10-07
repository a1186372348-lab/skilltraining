import type { PrismaClient } from "@prisma/client";

import type { HistorySessionDetailRow } from "./view";

/**
 * 训练历史回放的数据访问（training_sessions / hint_events / scores / session_feedback / questions）。
 * 全部查询按 user_id 收窄：历史仅返回当前用户记录（US-009）。
 *（T25：列表分页查询已随 GET /api/history 删除——大厅历史列表查询
 * 由 server/modules/training/hub-view.ts 承接）
 */

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
