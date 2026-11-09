import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { UserTransaction } from "@/server/lib/user-transaction";
import { requireStageEligibility } from "./eligibility";
import { STAGE_ERROR_CODES, StageError } from "./errors";
import { stageConsistent } from "./integrity";
import { judgeRetestResult } from "./judge";
import { validScoredDimensions } from "./metadata";
import type { RetestStart, StageReason } from "./types";

const includeSession = Prisma.validator<Prisma.RetestAttemptInclude>()({ session: { include: {
  scores: true, question: { select: { abilityTags: true, rubric: true } },
} } });
export type AttemptWithSession = Prisma.RetestAttemptGetPayload<{ include: typeof includeSession }>;

function missing(): StageError {
  return new StageError(STAGE_ERROR_CODES.STAGE_NOT_FOUND, 404, "复测不存在");
}

function rubricSupports(value: unknown, dimension: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const dimensions = (value as { dimensions?: unknown }).dimensions;
  if (!dimensions || typeof dimensions !== "object" || Array.isArray(dimensions)) return false;
  const points = (dimensions as Record<string, unknown>)[dimension];
  return Array.isArray(points) && points.some(point => typeof point === "string" && point.trim().length > 0);
}

function questionSupports(question: { status: string; kind: string; abilityTags: unknown; rubric: unknown }, dimension: string): boolean {
  return question.status === "published" && question.kind === "daily" && Array.isArray(question.abilityTags) &&
    question.abilityTags.includes(dimension) && rubricSupports(question.rubric, dimension);
}

function stillScorable(question: { abilityTags: unknown; rubric: unknown }, dimension: string): boolean {
  return Array.isArray(question.abilityTags) && question.abilityTags.includes(dimension) && rubricSupports(question.rubric, dimension);
}

export async function retestCandidate(context: UserTransaction, dimension: string): Promise<{
  id: string | null; reason: "no_candidate" | "reserved_by_pack";
}> {
  const [questions, sessions, attempts, reserved] = await Promise.all([
    context.tx.question.findMany({ where: { status: "published", kind: "daily" }, select: { id: true, status: true, kind: true, abilityTags: true, rubric: true }, orderBy: { id: "asc" } }),
    context.tx.trainingSession.findMany({ where: { userId: context.userId }, select: { questionId: true } }),
    context.tx.retestAttempt.findMany({ where: { userId: context.userId }, select: { questionId: true } }),
    context.tx.packItem.findMany({ where: { pack: { userId: context.userId, status: "active" } }, select: { questionId: true } }),
  ]);
  const used = new Set([...sessions, ...attempts].map(row => row.questionId));
  const held = new Set(reserved.map(row => row.questionId));
  const eligible = questions.filter(row => !used.has(row.id) && questionSupports(row, dimension));
  const available = eligible.find(row => !held.has(row.id));
  return { id: available?.id ?? null, reason: eligible.length ? "reserved_by_pack" : "no_candidate" };
}

export function attemptProblem(attempt: AttemptWithSession, dimension: string, triggerId: string): StageReason | null {
  const session = attempt.session;
  if (!session) return "session_missing";
  if (session.userId !== attempt.userId || session.questionId !== attempt.questionId || session.sourceType !== "retest" ||
    session.sourceId !== triggerId || session.id !== attempt.originalSessionId || session.state === "abandoned") return "inconsistent";
  if (session.state !== "scored") {
    const invalidSubmission = Boolean(session.finalSubmittedAt) !== (session.finalAnswer !== null) ||
      (Boolean(session.finalSubmittedAt) && session.state !== "followup");
    return session.scoredAt || session.scoreSequence !== null || session.scores.length || invalidSubmission ||
      !stillScorable(session.question, dimension) ? "inconsistent" : null;
  }
  const dimensions = validScoredDimensions(session.scoredDimensions);
  const matching = session.scores.filter(score => score.dimension === dimension);
  if (!session.scoredAt || !session.scoreSequence || !dimensions?.includes(dimension) ||
    session.scores.some(score => !dimensions.includes(score.dimension)) || matching.length !== 1 ||
    judgeRetestResult(matching[0].effectiveScore) === null) return "invalid_score";
  return null;
}

export async function activeAttempt(context: UserTransaction, triggerId: string): Promise<AttemptWithSession | null> {
  return context.tx.retestAttempt.findFirst({ where: { userId: context.userId, triggerId, status: "active" }, include: includeSession });
}

export async function settleScoredAttempts(context: UserTransaction): Promise<void> {
  const attempts = await context.tx.retestAttempt.findMany({ where: {
    userId: context.userId, status: "active", session: { is: { state: "scored" } },
  }, include: includeSession });
  for (const attempt of attempts) await settleOne(context, attempt);
}

async function settleOne(context: UserTransaction, attempt: AttemptWithSession): Promise<void> {
  await lockTrigger(context, attempt.triggerId);
  if (!await stageConsistent(context, attempt.dimension)) return;
  const trigger = await context.tx.stageRecord.findFirst({ where: {
    id: attempt.triggerId, userId: context.userId, dimension: attempt.dimension, type: "retest_trigger", settledAt: null,
  } });
  if (!trigger || attemptProblem(attempt, attempt.dimension, attempt.triggerId) || !attempt.session) return;
  const session = attempt.session;
  if (!session.scoreSequence || session.scoreSequence <= trigger.eventScoreSequence) return;
  const score = session.scores.find(row => row.dimension === attempt.dimension)!.effectiveScore;
  const outcome = judgeRetestResult(score);
  const progress = await context.tx.stageProgress.findUnique({ where: { userId_dimension: { userId: context.userId, dimension: attempt.dimension } } });
  const existing = await context.tx.stageRecord.findUnique({ where: { triggerId: trigger.id } });
  if (!outcome || !progress || existing || (progress.afterSequence !== null && session.scoreSequence <= progress.afterSequence)) return;
  const now = new Date();
  await context.tx.stageRecord.update({ where: { id: trigger.id }, data: { settledAt: now } });
  await context.tx.stageRecord.create({ data: {
    userId: context.userId, dimension: attempt.dimension, type: outcome === "pass" ? "retest_pass" : "retest_fail",
    triggerId: trigger.id, eventScoreSequence: session.scoreSequence,
    resultOriginalSessionId: attempt.originalSessionId, resultEffectiveScore: score,
  } });
  await context.tx.stageProgress.update({ where: { userId_dimension: { userId: context.userId, dimension: attempt.dimension } }, data: { afterSequence: session.scoreSequence } });
  await context.tx.retestAttempt.update({ where: { id: attempt.id }, data: { status: "settled", endedAt: now } });
}

async function lockAvailableQuestion(context: UserTransaction, dimension: string, questionId: string): Promise<boolean> {
  await context.tx.$queryRaw`SELECT id FROM questions WHERE id = ${questionId}::uuid FOR SHARE`;
  const question = await context.tx.question.findUnique({ where: { id: questionId }, select: { status: true, kind: true, abilityTags: true, rubric: true } });
  return Boolean(question && questionSupports(question, dimension));
}

async function lockTrigger(context: UserTransaction, triggerId: string): Promise<void> {
  await context.tx.$queryRaw`SELECT id FROM stage_records WHERE id = ${triggerId}::uuid AND user_id = ${context.userId}::uuid FOR UPDATE`;
}

async function availableQuestion(context: UserTransaction, dimension: string) {
  for (;;) {
    const candidate = await retestCandidate(context, dimension);
    if (!candidate.id) return candidate;
    if (await lockAvailableQuestion(context, dimension, candidate.id)) return candidate;
  }
}

export async function startRetestInTransaction(context: UserTransaction, triggerId: string): Promise<RetestStart> {
  await requireStageEligibility(context);
  if (!z.string().uuid().safeParse(triggerId).success) throw missing();
  await settleScoredAttempts(context);
  await lockTrigger(context, triggerId);
  const trigger = await context.tx.stageRecord.findFirst({ where: { id: triggerId, userId: context.userId, type: "retest_trigger" } });
  if (!trigger) throw missing();
  if (!await stageConsistent(context, trigger.dimension)) {
    return { state: "needs_recovery", triggerId, dimension: trigger.dimension, reason: "inconsistent" };
  }
  if (trigger.settledAt) {
    const result = await context.tx.stageRecord.findUnique({ where: { triggerId } });
    if (!result || result.type === "retest_trigger") return { state: "needs_recovery", triggerId, dimension: trigger.dimension, reason: "inconsistent" };
    const attempt = await context.tx.retestAttempt.findFirst({ where: { triggerId, userId: context.userId, status: "settled" }, orderBy: { endedAt: "desc" } });
    return { state: "settled", triggerId, dimension: trigger.dimension, outcome: result.type === "retest_pass" ? "pass" : "fail", sessionId: attempt?.sessionId ?? null };
  }
  const active = await activeAttempt(context, triggerId);
  if (active) {
    const problem = attemptProblem(active, trigger.dimension, triggerId) ?? (active.session?.state === "scored" ? "inconsistent" : null);
    if (problem) return { state: "needs_recovery", triggerId, dimension: trigger.dimension, reason: problem as "session_missing" | "invalid_score" | "inconsistent" };
    return { state: "ready", triggerId, dimension: trigger.dimension, sessionId: active.session!.id, sessionState: active.session!.state, awaitingScore: Boolean(active.session!.finalSubmittedAt) };
  }
  const candidate = await availableQuestion(context, trigger.dimension);
  if (!candidate.id) {
    return { state: "suspended", triggerId, dimension: trigger.dimension, reason: candidate.reason };
  }
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const session = await context.tx.trainingSession.create({ data: {
    userId: context.userId, questionId: candidate.id, date, startedAt: now, isExtra: true, sourceType: "retest", sourceId: trigger.id,
  }, select: { id: true, state: true } });
  await context.tx.retestAttempt.create({ data: {
    userId: context.userId, triggerId: trigger.id, dimension: trigger.dimension, questionId: candidate.id,
    sessionId: session.id, originalSessionId: session.id, startedAt: now,
  } });
  return { state: "ready", triggerId, dimension: trigger.dimension, sessionId: session.id, sessionState: session.state, awaitingScore: false };
}

export async function abandonRetestInTransaction(context: UserTransaction, sessionId: string): Promise<{ state: "abandoned" }> {
  await requireStageEligibility(context);
  if (!z.string().uuid().safeParse(sessionId).success) throw missing();
  const attempt = await context.tx.retestAttempt.findFirst({ where: { userId: context.userId, originalSessionId: sessionId }, include: includeSession });
  if (!attempt) throw missing();
  await lockTrigger(context, attempt.triggerId);
  if (attempt.status === "abandoned") return { state: "abandoned" };
  if (attempt.status !== "active" || attemptProblem(attempt, attempt.dimension, attempt.triggerId)) {
    throw new StageError(STAGE_ERROR_CODES.STAGE_CORRUPT, 409, "复测记录需要恢复");
  }
  const changed = await context.tx.trainingSession.updateMany({ where: {
    id: sessionId, userId: context.userId, state: { in: ["reading", "answering", "followup"] }, finalAnswer: null, finalSubmittedAt: null,
  }, data: { state: "abandoned" } });
  if (changed.count !== 1) throw new StageError(STAGE_ERROR_CODES.SESSION_ALREADY_SUBMITTED, 409, "最终答案已提交，不能终止");
  await context.tx.retestAttempt.update({ where: { id: attempt.id }, data: { status: "abandoned", endedAt: new Date() } });
  return { state: "abandoned" };
}
