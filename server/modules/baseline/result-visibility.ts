import type { Prisma, PrismaClient } from "@prisma/client";

/** 只读结果可见性条件；本人日常记录不受影响，基线须已完成且有参与证据。 */
export function visibleTrainingResultsWhere(userId: string): Prisma.TrainingSessionWhereInput {
  return {
    userId,
    OR: [
      { question: { kind: "daily" } },
      {
        question: { kind: "baseline" },
        user: { profile: { is: { baselineCompletedAt: { not: null } } } },
        OR: [
          { baselineActivatedAt: { not: null } },
          { firstAnswer: { not: null } },
          { finalAnswer: { not: null } },
          { firstSubmittedAt: { not: null } },
          { finalSubmittedAt: { not: null } },
          { scoredAt: { not: null } },
          { hintCount: { gt: 0 } },
          { followupHintCount: { gt: 0 } },
          { hintEvents: { some: {} } },
          { scores: { some: {} } },
          { state: { in: ["answering", "followup", "scored"] } },
        ],
      },
    ],
  };
}

export class BaselineRequiredError extends Error {
  constructor() {
    super("请先完成基线测评，再查看能力画像");
    this.name = "BaselineRequiredError";
  }
}

/** 曾开始基线但未完成时整份画像不揭晓；无基线会话的旧用户保持原有路径。 */
export async function assertAbilityResultsVisible(
  db: Pick<PrismaClient, "trainingSession">,
  userId: string,
): Promise<void> {
  const unfinished = await db.trainingSession.findFirst({
    where: {
      userId,
      question: { kind: "baseline" },
      user: { OR: [{ profile: { is: null } }, { profile: { is: { baselineCompletedAt: null } } }] },
    },
    select: { id: true },
  });
  if (unfinished) throw new BaselineRequiredError();
}
