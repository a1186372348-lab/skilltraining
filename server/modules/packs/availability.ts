import { z } from "zod";
import type { UserTransaction } from "@/server/lib/user-transaction";
import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";
import { assertPackVisible } from "./eligibility";
import { PACK_ERROR_CODES, PackError } from "./errors";
import { derivePackProgress } from "./progress";
import { candidates, readPack } from "./repository";
import { assertPackIntegrity } from "./view";

export type PackAvailabilityStatus = "available" | "active_same_dimension" | "active_other_dimension" |
  "insufficient_questions" | "baseline_required";

export interface PackAvailability {
  dimension: string;
  status: PackAvailabilityStatus;
  activePackId: string | null;
  availableQuestions: number;
  requiredQuestions: 5;
  completedCount: number | null;
}

async function completedCount(context: UserTransaction, activeId: string | null): Promise<number | null> {
  if (!activeId) return null;
  const pack = await readPack(context, activeId);
  if (!pack) return null;
  try { assertPackIntegrity(pack); } catch (error) {
    if (error instanceof PackError && error.code === PACK_ERROR_CODES.ITEM_INCONSISTENT) return null;
    throw error;
  }
  const progress = derivePackProgress(pack.status, pack.dimension, pack.items);
  return progress.items.some(item => item.state === "inconsistent") ? null : progress.completedCount;
}

/** 只读，不推进包、创建计划或会话；真正创建时会在锁内再次校验。 */
export async function getPackAvailabilityInTransaction(
  context: UserTransaction, dimensions: readonly string[],
): Promise<PackAvailability[]> {
  if (!z.array(z.enum(ABILITY_DIMENSIONS)).max(8).safeParse(dimensions).success) {
    throw new PackError(PACK_ERROR_CODES.INVALID_DIMENSION, 400, "请选择有效的能力维度");
  }
  await assertPackVisible(context);
  const [profile, active, pool] = await Promise.all([
    context.tx.userProfile.findUnique({ where: { userId: context.userId }, select: { baselineCompletedAt: true } }),
    context.tx.trainingPack.findFirst({ where: { userId: context.userId, status: "active" }, select: { id: true, dimension: true } }),
    candidates(context),
  ]);
  const count = await completedCount(context, active?.id ?? null);
  return dimensions.map(dimension => {
    const availableQuestions = new Set(pool.questions.filter(question =>
      Number.isInteger(question.difficulty) && question.difficulty >= 1 && question.difficulty <= 5 &&
      Array.isArray(question.abilityTags) && question.abilityTags.includes(dimension) && !pool.practiced.has(question.id),
    ).map(question => question.id)).size;
    const status: PackAvailabilityStatus = !profile?.baselineCompletedAt ? "baseline_required" :
      active ? active.dimension === dimension ? "active_same_dimension" : "active_other_dimension" :
      availableQuestions < 5 ? "insufficient_questions" : "available";
    return {
      dimension, status, activePackId: active?.id ?? null, availableQuestions, requiredQuestions: 5,
      completedCount: active?.dimension === dimension ? count : null,
    };
  });
}
