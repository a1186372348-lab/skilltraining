import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { UserTransaction } from "@/server/lib/user-transaction";
import { judgeRetestTrigger, selectInitialLegacyWindow, type StageObservation, type TriggerDecision } from "./judge";
import { validScoredDimensions } from "./metadata";

const scoreSelect = Prisma.validator<Prisma.TrainingSessionSelect>()({
  id: true, state: true, sourceType: true, scoredAt: true, scoreSequence: true, scoredDimensions: true,
  question: { select: { abilityTags: true } }, scores: { select: { dimension: true, effectiveScore: true } },
});
type ScoredRow = Prisma.TrainingSessionGetPayload<{ select: typeof scoreSelect }>;

const legacyEntry = z.strictObject({
  sessionId: z.string().uuid(), scoredAt: z.iso.datetime(), sourceType: z.enum(["daily", "extra", "plan", "pack"]),
});
const legacySchema = z.array(legacyEntry).max(3).refine(rows => new Set(rows.map(row => row.sessionId)).size === rows.length);

function valuesOf(row: ScoredRow, dimension: string): number[] {
  return row.scores.filter(score => score.dimension === dimension).map(score => score.effectiveScore);
}

function observation(row: ScoredRow, dimension: string): StageObservation {
  return {
    sessionId: row.id, dimension, sequence: row.scoreSequence,
    scoredAt: row.scoredAt ?? new Date(NaN), sourceType: row.sourceType, state: row.state,
    effectiveScores: valuesOf(row, dimension),
  };
}

function relevantLegacy(row: ScoredRow, dimension: string): boolean {
  return row.scoreSequence === null && (row.scores.some(score => score.dimension === dimension) ||
    (Array.isArray(row.question.abilityTags) && row.question.abilityTags.includes(dimension)));
}

export async function loadScoredRows(context: UserTransaction): Promise<ScoredRow[]> {
  return context.tx.trainingSession.findMany({ where: {
    userId: context.userId, state: "scored", sourceType: { in: ["daily", "extra", "plan", "pack"] },
  }, select: scoreSelect });
}

function newObservations(rows: readonly ScoredRow[], dimension: string, after: bigint | null): StageObservation[] | null {
  const result: StageObservation[] = [];
  for (const row of rows) {
    if (row.scoreSequence === null || (after !== null && row.scoreSequence <= after)) continue;
    const expected = validScoredDimensions(row.scoredDimensions);
    if (!expected || row.scores.some(score => !expected.includes(score.dimension))) return null;
    if (expected.includes(dimension)) result.push(observation(row, dimension));
  }
  return result;
}

async function initialize(context: UserTransaction, dimension: string, rows: readonly ScoredRow[]) {
  const selected = selectInitialLegacyWindow(dimension, rows.filter(row => relevantLegacy(row, dimension)).map(row => observation(row, dimension)));
  if (selected.status !== "ready") return null;
  const legacyWindow = selected.window.map(row => ({ sessionId: row.sessionId, scoredAt: row.scoredAt.toISOString(), sourceType: row.sourceType }));
  return context.tx.stageProgress.create({ data: { userId: context.userId, dimension, legacyWindow } });
}

function restoreLegacy(window: unknown, rows: readonly ScoredRow[], dimension: string): StageObservation[] | null {
  const parsed = legacySchema.safeParse(window);
  if (!parsed.success) return null;
  return parsed.data.map(saved => {
    const row = rows.find(item => item.id === saved.sessionId);
    const same = row && row.scoreSequence === null && row.scoredAt?.toISOString() === saved.scoredAt &&
      row.sourceType === saved.sourceType && relevantLegacy(row, dimension);
    return {
      sessionId: saved.sessionId, dimension, sequence: null, scoredAt: new Date(saved.scoredAt), sourceType: saved.sourceType,
      state: "scored", effectiveScores: same && row ? valuesOf(row, dimension) : [],
    };
  });
}

export async function evaluateDimension(
  context: UserTransaction, dimension: string, rows: readonly ScoredRow[],
): Promise<TriggerDecision> {
  let progress = await context.tx.stageProgress.findUnique({ where: { userId_dimension: { userId: context.userId, dimension } } });
  if (!progress) progress = await initialize(context, dimension, rows);
  if (!progress) return { status: "needs_recovery", consecutive: 0, qualifying: [] };
  const recent = newObservations(rows, dimension, progress.afterSequence);
  const legacy = progress.afterSequence === null ? restoreLegacy(progress.legacyWindow, rows, dimension) : null;
  if (!recent || (progress.afterSequence === null && !legacy)) return { status: "needs_recovery", consecutive: 0, qualifying: [] };
  return judgeRetestTrigger({ dimension, observations: recent, pending: false, afterSequence: progress.afterSequence, legacyWindow: legacy });
}
