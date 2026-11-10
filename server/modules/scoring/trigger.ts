import type { PrismaClient } from "@prisma/client";
import { acquireScoringLease, releaseScoringLease } from "./lease";
import { scoreSession, type ScoreSessionDeps } from "./service";

type DbClient = PrismaClient;
export interface TriggerSessionScoringDeps extends ScoreSessionDeps {
  scoreSession?: (db: DbClient, sessionId: string, userId: string, deps: ScoreSessionDeps) => Promise<unknown>;
  schedule?: (task: () => Promise<void>) => void;
  acquireLease?: typeof acquireScoringLease;
  releaseLease?: typeof releaseScoringLease;
}

const scoringInflight = new Set<string>();

/** 任务真正开始时跨实例领取，失败可在下次触发重试。 */
export function triggerSessionScoring(db: DbClient, sessionId: string, userId: string, deps: TriggerSessionScoringDeps = {}): void {
  const key = `${userId}:${sessionId}`;
  if (scoringInflight.has(key)) return;
  scoringInflight.add(key);
  const task = async (): Promise<void> => {
    let token: string | null = null;
    try {
      token = await (deps.acquireLease ?? acquireScoringLease)(db, sessionId, userId);
      if (token) await (deps.scoreSession ?? scoreSession)(db, sessionId, userId, deps);
    } catch (error: unknown) {
      console.error(`[scoring] 会话 ${sessionId} 后台评分失败，等待下一次触发重试`, error);
    } finally {
      try {
        if (token) await (deps.releaseLease ?? releaseScoringLease)(db, sessionId, userId, token);
      } catch (error: unknown) {
        console.error(`[scoring] 会话 ${sessionId} 释放评分租约失败，等待租约到期`, error);
      } finally {
        scoringInflight.delete(key);
      }
    }
  };
  if (deps.schedule) {
    try { deps.schedule(task); } catch (error) { scoringInflight.delete(key); throw error; }
  } else {
    void task();
  }
}
