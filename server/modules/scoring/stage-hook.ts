import type { PrismaClient } from "@prisma/client";
import { syncStagesAfterScoring } from "@/server/modules/stages";

export type StageScoredHook = (db: PrismaClient, userId: string) => Promise<unknown>;

/** 阶段恢复独立于评分提交和训练包恢复；未启用基线由阶段服务正常跳过。 */
export async function safelyReconcileStages(
  db: PrismaClient, userId: string, hook: StageScoredHook = syncStagesAfterScoring,
): Promise<void> {
  try { await hook(db, userId); }
  catch { console.warn(JSON.stringify({ event: "training.stage_reconcile_failed" })); }
}
