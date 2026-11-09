import type { UserTransaction } from "@/server/lib/user-transaction";

/** 只读检查事件、触发关闭状态和结算水位；异常交由恢复，不自动改写事实。 */
export async function stageConsistent(context: UserTransaction, dimension: string): Promise<boolean> {
  const [records, progress] = await Promise.all([
    context.tx.stageRecord.findMany({ where: { userId: context.userId, dimension } }),
    context.tx.stageProgress.findUnique({ where: { userId_dimension: { userId: context.userId, dimension } } }),
  ]);
  if (records.length && !progress) return false;
  const triggers = records.filter(row => row.type === "retest_trigger");
  const results = records.filter(row => row.type !== "retest_trigger");
  for (const trigger of triggers) {
    const result = results.find(row => row.triggerId === trigger.id);
    if (Boolean(trigger.settledAt) !== Boolean(result)) return false;
    if (result && result.eventScoreSequence <= trigger.eventScoreSequence) return false;
  }
  if (results.some(row => !triggers.some(trigger => trigger.id === row.triggerId))) return false;
  const expected = results.reduce<bigint | null>((latest, row) =>
    latest === null || row.eventScoreSequence > latest ? row.eventScoreSequence : latest, null);
  return (progress?.afterSequence ?? null) === expected;
}
