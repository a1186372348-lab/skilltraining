import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { UserTransaction } from "@/server/lib/user-transaction";
import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";
import { assertPackEligible, assertPackVisible } from "./eligibility";
import { PACK_ERROR_CODES, PackError } from "./errors";
import { derivePackProgress } from "./progress";
import { candidates, findActivePackId, insertPack, lockPack, readPack, type PackRecord } from "./repository";
import { selectPackQuestions } from "./selection";
import { assertPackIntegrity, packDetail, type PackDetail } from "./view";

function notFound(): PackError {
  return new PackError(PACK_ERROR_CODES.PACK_NOT_FOUND, 404, "训练包不存在");
}

export async function loadLockedPack(context: UserTransaction, packId: string): Promise<PackRecord> {
  if (!z.string().uuid().safeParse(packId).success || !await lockPack(context, packId)) throw notFound();
  const pack = await readPack(context, packId);
  if (!pack) throw notFound();
  assertPackIntegrity(pack);
  return pack;
}

/** 评分成功后可重入恢复；已终结、缺分或异常都不会继续推进。 */
export async function reconcileLockedPack(context: UserTransaction, pack: PackRecord): Promise<PackRecord> {
  const progress = derivePackProgress(pack.status, pack.dimension, pack.items);
  if (progress.shouldComplete) {
    await context.tx.trainingPack.update({ where: { id: pack.id }, data: { status: "completed", endedAt: new Date() } });
  } else if (progress.nextUnlockIndex !== null) {
    const item = pack.items[progress.nextUnlockIndex];
    await context.tx.packItem.updateMany({ where: { id: item.id, unlockedAt: null }, data: { unlockedAt: new Date() } });
  } else return pack;
  const updated = await readPack(context, pack.id);
  if (!updated) throw notFound();
  assertPackIntegrity(updated);
  return updated;
}

function isActiveConstraint(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const target = error.meta?.target;
  return target === "training_packs_one_active_per_user_idx" ||
    (Array.isArray(target) && target.length === 1 && target[0] === "user_id");
}

export async function createPackInTransaction(context: UserTransaction, dimension: string): Promise<PackDetail> {
  await assertPackEligible(context);
  if (!z.enum(ABILITY_DIMENSIONS).safeParse(dimension).success) {
    throw new PackError(PACK_ERROR_CODES.INVALID_DIMENSION, 400, "请选择有效的能力维度");
  }
  if (await findActivePackId(context)) {
    throw new PackError(PACK_ERROR_CODES.ACTIVE_PACK_EXISTS, 409, "请先完成或放弃当前训练包");
  }
  const pool = await candidates(context);
  const selected = selectPackQuestions(pool.questions, dimension, pool.practiced);
  try {
    return packDetail(await insertPack(context, dimension, selected, new Date()));
  } catch (error) {
    if (isActiveConstraint(error)) throw new PackError(PACK_ERROR_CODES.ACTIVE_PACK_EXISTS, 409, "请先完成或放弃当前训练包");
    throw error;
  }
}

export async function getPackInTransaction(context: UserTransaction, packId: string): Promise<PackDetail> {
  await assertPackVisible(context);
  const pack = await loadLockedPack(context, packId);
  return packDetail(await reconcileLockedPack(context, pack));
}

export async function getActivePackInTransaction(context: UserTransaction): Promise<PackDetail | null> {
  await assertPackVisible(context);
  const id = await findActivePackId(context);
  if (!id) return null;
  const pack = await reconcileLockedPack(context, await loadLockedPack(context, id));
  return pack.status === "active" ? packDetail(pack) : null;
}

/** 确认后终止未交终答的会话并放弃整包；已提交或已评分的数据保留。 */
export async function abandonPackInTransaction(
  context: UserTransaction, packId: string, options: { confirmed: boolean },
): Promise<PackDetail> {
  await assertPackVisible(context);
  if (!options.confirmed) throw new PackError(PACK_ERROR_CODES.CONFIRMATION_REQUIRED, 409, "请确认放弃整个训练包");
  const pack = await loadLockedPack(context, packId);
  if (pack.status === "abandoned") return packDetail(pack);
  if (pack.status !== "active" || derivePackProgress(pack.status, pack.dimension, pack.items).shouldComplete) {
    throw new PackError(PACK_ERROR_CODES.PACK_NOT_ACTIVE, 409, "训练包已经结束");
  }
  for (const item of pack.items) {
    const session = item.session;
    if (!session || session.finalSubmittedAt || session.state === "scored" || session.state === "abandoned") continue;
    const changed = await context.tx.trainingSession.updateMany({ where: {
      id: session.id, userId: context.userId, finalSubmittedAt: null, finalAnswer: null,
      state: { in: ["reading", "answering", "followup"] },
    }, data: { state: "abandoned" } });
    if (changed.count !== 1) throw new PackError(PACK_ERROR_CODES.ITEM_INCONSISTENT, 409, "训练状态已变化，请重试");
  }
  await context.tx.trainingPack.update({ where: { id: pack.id }, data: { status: "abandoned", endedAt: new Date() } });
  const updated = await readPack(context, pack.id);
  if (!updated) throw notFound();
  return packDetail(updated);
}
