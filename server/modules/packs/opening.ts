import type { UserTransaction } from "@/server/lib/user-transaction";
import { assertPackEligible } from "./eligibility";
import { PACK_ERROR_CODES, PackError } from "./errors";
import { loadLockedPack, reconcileLockedPack } from "./lifecycle";
import type { PackItemState } from "./progress";
import { lockPlan } from "./repository";
import { packDetail } from "./view";

export interface OpenPackItemResult {
  sessionId: string;
  state: PackItemState;
}

/** 测试可以注入时钟；应由服务端控制，不能来自请求正文。 */
export interface PackClockOptions {
  now?: () => Date;
}

function weekStartUtc(date: Date): Date {
  const day = (date.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day));
}

function validTime(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("无效的训练时间");
  return new Date(value);
}

async function currentPlan(context: UserTransaction, dimension: string, clock: () => Date) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const week = weekStartUtc(validTime(clock));
    const candidate = await context.tx.trainingPlan.findUnique({
      where: { userId_weekStartDate: { userId: context.userId, weekStartDate: week } }, select: { id: true },
    });
    if (candidate) await lockPlan(context, candidate.id);
    const now = validTime(clock);
    if (weekStartUtc(now).getTime() !== week.getTime()) continue;
    const plan = candidate && await context.tx.trainingPlan.findFirst({ where: {
      id: candidate.id, userId: context.userId, weekStartDate: week, status: "active", focusDimension: dimension,
    }, select: { id: true } });
    return { now, planId: plan?.id ?? null };
  }
  throw new Error("确定训练所属周失败，请重试");
}

async function assertQuestionAvailable(context: UserTransaction, questionId: string): Promise<void> {
  await context.tx.$queryRaw`SELECT id FROM questions WHERE id = ${questionId}::uuid FOR SHARE`;
  const question = await context.tx.question.findUnique({ where: { id: questionId }, select: { status: true, kind: true } });
  if (!question || question.status !== "published" || question.kind !== "daily") {
    throw new PackError(PACK_ERROR_CODES.QUESTION_UNAVAILABLE, 409, "题目暂不可用，可放弃该训练包");
  }
}

async function assertNoOtherSession(context: UserTransaction): Promise<void> {
  const existing = await context.tx.trainingSession.findFirst({ where: {
    userId: context.userId, sourceType: { not: "retest" }, finalSubmittedAt: null, state: { in: ["reading", "answering", "followup"] },
    question: { kind: "daily" },
  }, select: { id: true } });
  if (existing) throw new PackError(PACK_ERROR_CODES.SESSION_IN_PROGRESS, 409, "请先完成或终止当前训练");
}

export async function openPackItemInTransaction(
  context: UserTransaction, packId: string, orderIndex: number, options: PackClockOptions = {},
): Promise<OpenPackItemResult> {
  await assertPackEligible(context);
  const pack = await reconcileLockedPack(context, await loadLockedPack(context, packId));
  if (pack.status !== "active") throw new PackError(PACK_ERROR_CODES.PACK_NOT_ACTIVE, 409, "训练包已经结束");
  if (!Number.isInteger(orderIndex) || orderIndex < 0 || orderIndex > 4) {
    throw new PackError(PACK_ERROR_CODES.ITEM_LOCKED, 409, "训练题尚未解锁");
  }
  const item = pack.items[orderIndex];
  const items = packDetail(pack).items;
  if (items.some(row => row.state === "inconsistent")) {
    throw new PackError(PACK_ERROR_CODES.ITEM_INCONSISTENT, 409, "训练记录需要恢复");
  }
  const view = items[orderIndex];
  if (view.state === "locked") throw new PackError(PACK_ERROR_CODES.ITEM_LOCKED, 409, "训练题尚未解锁");
  if (item.session) return { sessionId: item.session.id, state: view.state };
  await assertQuestionAvailable(context, item.questionId);
  await assertNoOtherSession(context);
  const { now, planId } = await currentPlan(context, pack.dimension, options.now ?? (() => new Date()));
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const session = await context.tx.trainingSession.create({ data: {
    userId: context.userId, questionId: item.questionId, date, startedAt: now,
    state: "reading", isExtra: true, sourceType: "pack", sourceId: pack.id, linkedPlanId: planId,
  }, select: { id: true } });
  const attached = await context.tx.packItem.updateMany({ where: {
    id: item.id, sessionId: null, startedAt: null, unlockedAt: { not: null },
  }, data: { sessionId: session.id, startedAt: now } });
  if (attached.count !== 1) throw new PackError(PACK_ERROR_CODES.ITEM_INCONSISTENT, 409, "训练记录已变化，请重试");
  return { sessionId: session.id, state: "in_progress" };
}
