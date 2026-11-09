import type { UserTransaction } from "@/server/lib/user-transaction";
import { assertAbilityResultsVisible, BaselineRequiredError } from "@/server/modules/baseline/result-visibility";
import { PACK_ERROR_CODES, PackError } from "./errors";

function baselineRequired(): PackError {
  return new PackError(PACK_ERROR_CODES.BASELINE_REQUIRED, 409, "请先完成基线测评");
}

/** 只读门禁：已有未完成的基线时不暴露结果或推进包。 */
export async function assertPackVisible(context: UserTransaction): Promise<void> {
  try {
    await assertAbilityResultsVisible(context.tx, context.userId);
  } catch (error) {
    if (error instanceof BaselineRequiredError) throw baselineRequired();
    throw error;
  }
}

/** 新包及开题必须有真实完成标记；无基线的历史用户仅享有读取豁免。 */
export async function assertPackEligible(context: UserTransaction): Promise<void> {
  await assertPackVisible(context);
  const profile = await context.tx.userProfile.findUnique({
    where: { userId: context.userId }, select: { baselineCompletedAt: true },
  });
  if (!profile?.baselineCompletedAt) throw baselineRequired();
}
