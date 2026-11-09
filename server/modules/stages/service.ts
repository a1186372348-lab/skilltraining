import type { PrismaClient, StageRecord } from "@prisma/client";
import { withUserTransaction, type UserTransaction } from "@/server/lib/user-transaction";
import { getAbilityProfileView } from "@/server/modules/profile/ability";
import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";
import { requireStageEligibility, stageEligibility } from "./eligibility";
import { stageConsistent } from "./integrity";
import { resolveDimensionStage, resolveGlobalStage, type TriggerDecision } from "./judge";
import { evaluateDimension, loadScoredRows } from "./observation";
import { abandonRetestInTransaction, activeAttempt, attemptProblem, retestCandidate, settleScoredAttempts, startRetestInTransaction } from "./retest";
import type { StageDimensionView, StageOverview } from "./types";

type Decisions = Map<string, TriggerDecision>;

function qualifyingJson(decision: TriggerDecision) {
  return decision.qualifying.map(item => ({
    sessionId: item.sessionId, scoredAt: item.scoredAt.toISOString(),
    sequence: item.sequence?.toString() ?? null, effectiveScore: item.effectiveScore,
  }));
}

async function reconcileCore(context: UserTransaction): Promise<Decisions> {
  await settleScoredAttempts(context);
  const rows = await loadScoredRows(context);
  const decisions: Decisions = new Map();
  for (const dimension of ABILITY_DIMENSIONS) {
    if (!await stageConsistent(context, dimension)) {
      decisions.set(dimension, { status: "needs_recovery", consecutive: 0, qualifying: [] });
      continue;
    }
    const pending = await context.tx.stageRecord.findFirst({ where: {
      userId: context.userId, dimension, type: "retest_trigger", settledAt: null,
    }, select: { id: true } });
    if (pending) continue;
    const decision = await evaluateDimension(context, dimension, rows);
    decisions.set(dimension, decision);
    if (decision.status !== "trigger") continue;
    const last = decision.qualifying[decision.qualifying.length - 1];
    await context.tx.stageRecord.create({ data: {
      userId: context.userId, dimension, type: "retest_trigger", qualifying: qualifyingJson(decision),
      eventScoreSequence: last.sequence ?? BigInt(0),
    } });
  }
  return decisions;
}

export async function reconcileStagesInTransaction(context: UserTransaction): Promise<void> {
  await requireStageEligibility(context);
  await reconcileCore(context);
}

/** 评分后最佳努力入口：尚未完成基线是正常跳过，真正失败由调用方脱敏记录。 */
export async function syncStagesAfterScoringInTransaction(context: UserTransaction): Promise<{ status: "skipped" | "reconciled" }> {
  const profile = await context.tx.userProfile.findUnique({ where: { userId: context.userId }, select: { baselineCompletedAt: true } });
  if (!profile?.baselineCompletedAt) return { status: "skipped" };
  await reconcileStagesInTransaction(context);
  return { status: "reconciled" };
}

async function viewDimension(
  context: UserTransaction, dimension: string, observed: boolean, records: readonly StageRecord[], decision: TriggerDecision | undefined,
): Promise<StageDimensionView> {
  const pending = records.find(row => row.dimension === dimension && row.type === "retest_trigger" && !row.settledAt);
  const latest = records.find(row => row.dimension === dimension);
  const base: StageDimensionView = {
    dimension, observed, status: resolveDimensionStage(latest?.type ?? null, true),
    consecutive: decision?.status === "waiting" ? decision.consecutive : null,
    triggerId: null, activeSessionId: null, activeSessionStatus: null, reason: null,
  };
  if (decision?.status === "needs_recovery" || !await stageConsistent(context, dimension)) {
    return { ...base, triggerId: pending?.id ?? null, status: "needs_recovery", reason: "inconsistent" };
  }
  if (!pending) return base;
  const attempt = await activeAttempt(context, pending.id);
  if (attempt) {
    const problem = attemptProblem(attempt, dimension, pending.id) ?? (attempt.session?.state === "scored" ? "inconsistent" : null);
    return {
      ...base, triggerId: pending.id, status: problem ? "needs_recovery" : "pending",
      activeSessionId: problem ? null : attempt.session!.id,
      activeSessionStatus: problem ? null : attempt.session!.finalSubmittedAt ? "awaiting_score" : "in_progress",
      reason: problem,
    };
  }
  const candidate = await retestCandidate(context, dimension);
  return { ...base, triggerId: pending.id, status: candidate.id ? "pending" : "suspended", reason: candidate.id ? null : candidate.reason };
}

export async function getStageOverviewInTransaction(context: UserTransaction): Promise<StageOverview> {
  const baselineCompleted = await stageEligibility(context);
  const decisions = baselineCompleted ? await reconcileCore(context) : new Map<string, TriggerDecision>();
  const [profile, records] = await Promise.all([
    getAbilityProfileView(context.tx, context.userId),
    context.tx.stageRecord.findMany({ where: { userId: context.userId }, orderBy: [
      { eventScoreSequence: "desc" }, { createdAt: "desc" }, { id: "desc" },
    ] }),
  ]);
  const dimensions = await Promise.all(profile.map(row => viewDimension(context, row.dimension, row.observed, records, decisions.get(row.dimension))));
  const observed = new Set(profile.filter(row => row.observed).map(row => row.dimension));
  const stage = resolveGlobalStage(observed, records.some(row => row.type === "retest_trigger" && !row.settledAt));
  return { stage, baselineCompleted, dimensions, timeline: records.map(row => ({
    id: row.id, dimension: row.dimension, type: row.type, createdAt: row.createdAt.toISOString(), resultEffectiveScore: row.resultEffectiveScore,
  })) };
}

export function getStageOverview(db: PrismaClient, userId: string) {
  return withUserTransaction(db, userId, getStageOverviewInTransaction);
}

export function reconcileStages(db: PrismaClient, userId: string) {
  return withUserTransaction(db, userId, reconcileStagesInTransaction);
}

export function syncStagesAfterScoring(db: PrismaClient, userId: string) {
  return withUserTransaction(db, userId, syncStagesAfterScoringInTransaction);
}

export function startRetest(db: PrismaClient, userId: string, triggerId: string) {
  return withUserTransaction(db, userId, context => startRetestInTransaction(context, triggerId));
}

export function abandonRetest(db: PrismaClient, userId: string, sessionId: string) {
  return withUserTransaction(db, userId, context => abandonRetestInTransaction(context, sessionId));
}

export { abandonRetestInTransaction, startRetestInTransaction } from "./retest";
