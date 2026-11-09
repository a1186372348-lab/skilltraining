import type { PrismaClient, TrainingSession } from "@prisma/client";
import { SCORING_ERROR_CODES, ScoringError } from "./errors";

/** 只验证未评分的本人复测；已评分事实由保存的维度快照恢复。 */
export async function assertRetestTarget(
  db: Pick<PrismaClient, "retestAttempt">,
  session: Pick<TrainingSession, "id" | "userId" | "questionId" | "sourceType" | "sourceId">,
  rubricDimensions: Readonly<Record<string, readonly string[]>>,
): Promise<void> {
  if (session.sourceType !== "retest") return;
  const attempt = session.sourceId && await db.retestAttempt.findFirst({ where: {
    userId: session.userId, sessionId: session.id, originalSessionId: session.id,
    triggerId: session.sourceId, questionId: session.questionId, status: "active",
  }, select: { dimension: true } });
  if (!attempt || !rubricDimensions[attempt.dimension]?.some(point => point.trim().length > 0)) {
    throw new ScoringError(SCORING_ERROR_CODES.QUESTION_RUBRIC_INVALID, 409, "复测题的目标维度需要恢复");
  }
}
