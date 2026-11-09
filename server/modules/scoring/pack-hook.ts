import type { PrismaClient, TrainingSession } from "@prisma/client";
import { getPack } from "@/server/modules/packs";

export type PackScoredHook = (db: PrismaClient, userId: string, packId: string) => Promise<unknown>;

/** 评分已提交后运行；失败只记录脱敏事件，包读取时会再次 reconcile。 */
export async function safelyAdvancePack(
  db: PrismaClient, userId: string, session: Pick<TrainingSession, "sourceType" | "sourceId">,
  hook: PackScoredHook = getPack,
): Promise<void> {
  if (session.sourceType !== "pack") return;
  if (!session.sourceId) {
    console.warn(JSON.stringify({ event: "training.pack_reconcile_missing_source" }));
    return;
  }
  try { await hook(db, userId, session.sourceId); }
  catch { console.warn(JSON.stringify({ event: "training.pack_reconcile_failed" })); }
}
