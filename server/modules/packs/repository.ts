import { Prisma } from "@prisma/client";
import type { UserTransaction } from "@/server/lib/user-transaction";
import type { SelectedPackQuestion } from "./selection";

const graph = Prisma.validator<Prisma.TrainingPackInclude>()({
  items: {
    orderBy: { orderIndex: "asc" },
    include: {
      question: { select: { id: true, caseTitle: true, status: true, kind: true } },
      session: { select: {
        id: true, userId: true, questionId: true, sourceType: true, sourceId: true,
        state: true, finalAnswer: true, finalSubmittedAt: true, scoredAt: true,
        scores: { select: { dimension: true, effectiveScore: true } },
      } },
    },
  },
});

export type PackRecord = Prisma.TrainingPackGetPayload<{ include: typeof graph }>;

/** 调用方已经持有用户行锁；本函数再锁本人拥有的包。 */
export async function lockPack(context: UserTransaction, packId: string): Promise<boolean> {
  const rows = await context.tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM training_packs WHERE id = ${packId}::uuid AND user_id = ${context.userId}::uuid FOR UPDATE
  `;
  return rows.length === 1;
}

export function readPack(context: UserTransaction, id: string): Promise<PackRecord | null> {
  return context.tx.trainingPack.findFirst({ where: { id, userId: context.userId }, include: graph });
}

export async function findActivePackId(context: UserTransaction): Promise<string | null> {
  const pack = await context.tx.trainingPack.findFirst({
    where: { userId: context.userId, status: "active" }, select: { id: true },
  });
  return pack?.id ?? null;
}

export async function candidates(context: UserTransaction) {
  const [questions, sessions] = await Promise.all([
    context.tx.question.findMany({
      where: { status: "published", kind: "daily" },
      select: { id: true, difficulty: true, abilityTags: true, status: true, kind: true },
    }),
    context.tx.trainingSession.findMany({ where: { userId: context.userId }, select: { questionId: true } }),
  ]);
  return { questions, practiced: new Set(sessions.map(row => row.questionId)) };
}

export function insertPack(context: UserTransaction, dimension: string, selected: SelectedPackQuestion[], now: Date) {
  return context.tx.trainingPack.create({ data: {
    userId: context.userId, dimension,
    items: { create: selected.map((item, index) => ({
      questionId: item.questionId, orderIndex: index, targetTier: item.targetTier,
      actualTier: item.actualTier, actualDifficulty: item.actualDifficulty,
      unlockedAt: index === 0 ? now : null,
    })) },
  }, include: graph });
}

export async function lockPlan(context: UserTransaction, id: string): Promise<void> {
  await context.tx.$queryRaw`
    SELECT id FROM training_plans WHERE id = ${id}::uuid AND user_id = ${context.userId}::uuid FOR UPDATE
  `;
}
