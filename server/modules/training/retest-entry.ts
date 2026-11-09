import type { UserTransaction } from "@/server/lib/user-transaction";
import type { RetestSelection } from "@/server/modules/selection/service";
import { getStageOverviewInTransaction, startRetestInTransaction, StageError } from "@/server/modules/stages";
import { TrainingError } from "./errors";

/** 事务内恢复本人首个可进行复测；无题挂起时让普通选题继续。 */
export async function pickRetestInTransaction(context: UserTransaction): Promise<RetestSelection | null> {
  try {
    const overview = await getStageOverviewInTransaction(context);
    if (!overview.baselineCompleted) return null;
    for (const dimension of overview.dimensions) {
      if (dimension.status === "needs_recovery") {
        console.warn(JSON.stringify({ event: "training.retest_recommendation_needs_recovery" }));
        continue;
      }
      if (dimension.status !== "pending" || !dimension.triggerId) continue;
      const result = await startRetestInTransaction(context, dimension.triggerId);
      if (result.state === "suspended" || result.state === "settled") continue;
      if (result.state === "needs_recovery") {
        console.warn(JSON.stringify({ event: "training.retest_recommendation_needs_recovery" }));
        continue;
      }
      const session = await context.tx.trainingSession.findFirst({
        where: { id: result.sessionId, userId: context.userId, sourceType: "retest", sourceId: result.triggerId },
        include: { question: true },
      });
      if (!session) throw new TrainingError("RETEST_NEEDS_RECOVERY", 409, "复测记录需要恢复，请前往成长阶段查看");
      return { question: session.question, sessionId: session.id, triggerId: result.triggerId, dimension: result.dimension };
    }
    return null;
  } catch (error) {
    if (error instanceof StageError) throw new TrainingError(error.code, error.httpStatus, error.message);
    throw error;
  }
}
