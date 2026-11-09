import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

// 已应用迁移不变；重跑只处理经核实的历史用户、会话和截止时间。
// 已有 plan/pack/retest 或来源对象的会话不能由 isExtra 重新推断。
const backfillScopeSchema = z.strictObject({
  userId: z.uuid(),
  sessionIds: z.array(z.uuid()).min(1).max(1000).refine(ids => new Set(ids).size === ids.length),
  before: z.date().refine(value => value.getTime() < Date.now()),
});

export type BackfillScope = { userId: string; sessionIds: readonly string[]; before: Date };

export async function backfillSessionSource(
  db: PrismaClient,
  scope: Partial<BackfillScope> = {},
): Promise<{ updated: number }> {
  const parsed = backfillScopeSchema.safeParse(scope);
  if (!parsed.success) throw new Error("历史回填必须提供已核实的用户、唯一会话清单和过去的截止时间");
  const { userId, sessionIds, before } = parsed.data;
  const updated = await db.$executeRaw`
    UPDATE "training_sessions" AS s
    SET "source_type" = CASE
        WHEN q."kind" = 'baseline' THEN 'baseline'::"TrainingSessionSource"
        WHEN s."is_extra" THEN 'extra'::"TrainingSessionSource"
        ELSE 'daily'::"TrainingSessionSource"
      END
    FROM "questions" AS q
    WHERE s."question_id" = q."id"
      AND s."user_id" = ${userId}::uuid
      AND s."id" IN (${Prisma.join(sessionIds.map(id => Prisma.sql`${id}::uuid`))})
      AND s."started_at" < ${before}
      AND s."source_id" IS NULL
      AND s."source_type" IN ('daily', 'extra', 'baseline')
      AND s."source_type" IS DISTINCT FROM CASE
        WHEN q."kind" = 'baseline' THEN 'baseline'::"TrainingSessionSource"
        WHEN s."is_extra" THEN 'extra'::"TrainingSessionSource"
        ELSE 'daily'::"TrainingSessionSource"
      END
  `;
  return { updated };
}
