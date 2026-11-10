import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/** 原子领取，使用数据库时钟避免各实例时钟偏差；不得持事务等待 AI。 */
export async function acquireScoringLease(db: PrismaClient, sessionId: string, userId: string): Promise<string | null> {
  const token = randomUUID();
  const updated = await db.$executeRaw`
    UPDATE training_sessions AS s
    SET scoring_lease_token = ${token}::uuid,
        scoring_lease_expires_at = clock_timestamp() + INTERVAL '330 seconds'
    WHERE s.id = ${sessionId}::uuid AND s.user_id = ${userId}::uuid
      AND s.state = 'followup' AND s.final_answer IS NOT NULL
      AND s.final_submitted_at IS NOT NULL AND s.scored_at IS NULL
      AND (s.scoring_lease_expires_at IS NULL OR s.scoring_lease_expires_at <= clock_timestamp())
      AND NOT EXISTS (SELECT 1 FROM scores WHERE session_id = s.id)
  `;
  return updated === 1 ? token : null;
}

/** 仅当前持有者可释放；旧任务结束时不得清除已被接管的租约。 */
export async function releaseScoringLease(db: PrismaClient, sessionId: string, userId: string, token: string): Promise<void> {
  await db.$executeRaw`
    UPDATE training_sessions
    SET scoring_lease_token = NULL, scoring_lease_expires_at = NULL
    WHERE id = ${sessionId}::uuid AND user_id = ${userId}::uuid AND scoring_lease_token = ${token}::uuid
  `;
}
