import type { UserTransaction } from "@/server/lib/user-transaction";
import { assertAbilityResultsVisible, BaselineRequiredError } from "@/server/modules/baseline/result-visibility";
import { STAGE_ERROR_CODES, StageError } from "./errors";

export async function stageEligibility(context: UserTransaction): Promise<boolean> {
  try { await assertAbilityResultsVisible(context.tx, context.userId); }
  catch (error) {
    if (error instanceof BaselineRequiredError) throw new StageError(STAGE_ERROR_CODES.BASELINE_REQUIRED, 409, "请先完成基线测评");
    throw error;
  }
  const profile = await context.tx.userProfile.findUnique({ where: { userId: context.userId }, select: { baselineCompletedAt: true } });
  return Boolean(profile?.baselineCompletedAt);
}

export async function requireStageEligibility(context: UserTransaction): Promise<void> {
  if (!await stageEligibility(context)) throw new StageError(STAGE_ERROR_CODES.BASELINE_REQUIRED, 409, "请先完成基线测评");
}
