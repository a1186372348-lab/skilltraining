import type { Question, TrainingSession } from "@prisma/client";

import type { UserTransaction } from "@/server/lib/user-transaction";
import {
  getActivePackInTransaction, openPackItemInTransaction, PackError, type PackItemView,
} from "@/server/modules/packs";

import { TrainingError } from "./errors";

type Item = Pick<PackItemView, "orderIndex" | "state" | "sessionId">;
type PackAction = { kind: "open"; orderIndex: number } | { kind: "resume"; sessionId: string };
type SessionWithQuestion = TrainingSession & { question: Question };
export type PackEntryResult = { active: boolean; session: SessionWithQuestion | null; reservedQuestionIds: string[] };
type PackEntryDependencies = { getActive: typeof getActivePackInTransaction; openItem: typeof openPackItemInTransaction };
const defaultDependencies: PackEntryDependencies = { getActive: getActivePackInTransaction, openItem: openPackItemInTransaction };

/** 同一时刻仅允许一道可操作题；损坏状态不得降级为普通选题。 */
export function nextPackAction(items: readonly Item[]): PackAction {
  if (items.some(item => item.state === "inconsistent")) throw new TrainingError("ITEM_INCONSISTENT", 409, "训练包记录需要恢复");
  const actionable = items.filter(item => !["locked", "scored"].includes(item.state));
  if (actionable.length !== 1) throw new TrainingError("ITEM_INCONSISTENT", 409, "训练包进度异常，请稍后重试");
  const item = actionable[0];
  if (item.state === "unavailable") throw new TrainingError("QUESTION_UNAVAILABLE", 409, "训练包题目暂不可用，可放弃训练包");
  if (item.state === "available") return { kind: "open", orderIndex: item.orderIndex };
  if ((item.state === "in_progress" || item.state === "awaiting_score") && item.sessionId) return { kind: "resume", sessionId: item.sessionId };
  throw new TrainingError("ITEM_INCONSISTENT", 409, "训练包记录需要恢复");
}

async function ownedSession(context: UserTransaction, sessionId: string, packId: string): Promise<SessionWithQuestion> {
  const session = await context.tx.trainingSession.findFirst({
    where: { id: sessionId, userId: context.userId, sourceType: "pack", sourceId: packId }, include: { question: true },
  });
  if (!session) throw new TrainingError("ITEM_INCONSISTENT", 409, "训练包会话需要恢复");
  return session;
}

/** 调用方必须持用户锁，且不可嵌套公共包事务。 */
export async function resolveActivePackSession(context: UserTransaction, open: boolean, deps: PackEntryDependencies = defaultDependencies): Promise<PackEntryResult> {
  try {
    // 无包时沿用普通训练的既有门禁；有包才进入包域的可见性守卫和恢复逻辑。
    const activeId = await context.tx.trainingPack.findFirst({
      where: { userId: context.userId, status: "active" }, select: { id: true },
    });
    if (!activeId) return { active: false, session: null, reservedQuestionIds: [] };
    const pack = await deps.getActive(context);
    if (!pack) return { active: false, session: null, reservedQuestionIds: [] };
    const reservedQuestionIds = pack.items.map(item => item.questionId);
    const action = nextPackAction(pack.items);
    const ordinary = await context.tx.trainingSession.findFirst({
      where: {
        userId: context.userId, sourceType: { notIn: ["pack", "retest"] }, finalSubmittedAt: null,
        state: { in: ["reading", "answering", "followup"] }, question: { kind: "daily" },
      },
      include: { question: true }, orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    });
    if (ordinary) return { active: true, session: ordinary, reservedQuestionIds };
    if (action.kind === "open" && !open) return { active: true, session: null, reservedQuestionIds };
    const sessionId = action.kind === "resume" ? action.sessionId : (await deps.openItem(context, pack.id, action.orderIndex)).sessionId;
    return { active: true, session: await ownedSession(context, sessionId, pack.id), reservedQuestionIds };
  } catch (error) {
    if (error instanceof PackError) throw new TrainingError(error.code, error.httpStatus, error.message);
    throw error;
  }
}
