import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";

export interface StageObservation {
  sessionId: string;
  dimension: string;
  /** 新评分为持久化单调序号；旧评分保持 null。 */
  sequence: bigint | null;
  scoredAt: Date;
  sourceType: string;
  state: string;
  /** 本会话目标维的全部评分；缺失或重复均不能拼接三连。 */
  effectiveScores: readonly unknown[];
}

export interface QualifyingObservation {
  sessionId: string;
  sequence: bigint | null;
  scoredAt: Date;
  effectiveScore: number;
}

export interface TriggerDecision {
  status: "trigger" | "waiting" | "pending" | "needs_recovery";
  consecutive: number;
  qualifying: QualifyingObservation[];
}

export interface TriggerInput {
  dimension: string;
  observations: readonly StageObservation[];
  pending: boolean;
  /** 最近一次复测结算时已经消费的评分序号。 */
  afterSequence: bigint | null;
  /** 首次确定并持久化的旧评分窗口；结算后必须为 null。 */
  legacyWindow?: readonly StageObservation[] | null;
}

const ALLOWED_SOURCES = new Set(["daily", "extra", "plan", "pack"]);

function decision(status: TriggerDecision["status"], qualifying: QualifyingObservation[] = []): TriggerDecision {
  return { status, consecutive: qualifying.length, qualifying };
}

function sameObservation(a: StageObservation, b: StageObservation): boolean {
  return a.sequence === b.sequence && a.scoredAt.getTime() === b.scoredAt.getTime() &&
    a.sourceType === b.sourceType && a.effectiveScores.length === b.effectiveScores.length &&
    a.effectiveScores.every((value, index) => Object.is(value, b.effectiveScores[index]));
}

function matches(row: StageObservation, dimension: string): boolean {
  return row.dimension === dimension && row.state === "scored" && ALLOWED_SOURCES.has(row.sourceType);
}

function uniqueRows(rows: readonly StageObservation[]): StageObservation[] | null {
  const sessions = new Map<string, StageObservation>();
  const numbered = new Map<bigint, string>();
  for (const row of rows) {
    if (row.sequence !== null && (typeof row.sequence !== "bigint" || row.sequence <= BigInt(0))) return null;
    if (typeof row.sessionId !== "string" || !row.sessionId || !(row.scoredAt instanceof Date) ||
      !Number.isFinite(row.scoredAt.getTime()) || !Array.isArray(row.effectiveScores)) return null;
    const previous = sessions.get(row.sessionId);
    if (previous && !sameObservation(previous, row)) return null;
    if (row.sequence !== null && numbered.has(row.sequence) && numbered.get(row.sequence) !== row.sessionId) return null;
    sessions.set(row.sessionId, row);
    if (row.sequence !== null) numbered.set(row.sequence, row.sessionId);
  }
  return [...sessions.values()];
}

/** 只在初始化时调用；后续读取必须复用持久化的窗口，不得再次选取。 */
export function selectInitialLegacyWindow(dimension: string, observations: readonly StageObservation[]): {
  status: "ready" | "needs_recovery"; window: StageObservation[];
} {
  const unique = uniqueRows(observations.filter(row => row.sequence === null && matches(row, dimension)));
  if (!unique) return { status: "needs_recovery", window: [] };
  const window = unique.sort((a, b) =>
    a.scoredAt.getTime() - b.scoredAt.getTime() || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
  ).slice(-3).map(row => ({ ...row, scoredAt: new Date(row.scoredAt), effectiveScores: [...row.effectiveScores] }));
  return { status: "ready", window };
}

function prepare(input: TriggerInput): StageObservation[] | null {
  if (input.afterSequence !== null && (typeof input.afterSequence !== "bigint" || input.afterSequence < BigInt(0))) return null;
  const legacy = input.legacyWindow ?? [];
  if ((input.legacyWindow && input.afterSequence !== null) || legacy.length > 3 ||
    legacy.some(row => row.sequence !== null || !matches(row, input.dimension))) return null;
  const recent = input.observations.filter(row => matches(row, input.dimension) && row.sequence !== null);
  if (recent.some(row => typeof row.sequence !== "bigint" || row.sequence <= BigInt(0))) return null;
  const unseen = recent.filter(row => input.afterSequence === null || row.sequence! > input.afterSequence);
  const combined = uniqueRows([...legacy, ...unseen]);
  if (!combined) return null;
  const sortedLegacy = combined.filter(row => row.sequence === null).sort((a, b) =>
    a.scoredAt.getTime() - b.scoredAt.getTime() || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
  );
  const sortedRecent = combined.filter(row => row.sequence !== null)
    .sort((a, b) => a.sequence! < b.sequence! ? -1 : a.sequence! > b.sequence! ? 1 : 0);
  return [...sortedLegacy, ...sortedRecent];
}

function validScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** 从已持久化观察边界恢复首个三连；无效/重复评分是连续性中断而不是零分。 */
export function judgeRetestTrigger(input: TriggerInput): TriggerDecision {
  if (input.pending) return decision("pending");
  const rows = prepare(input);
  if (!rows) return decision("needs_recovery");
  let streak: QualifyingObservation[] = [];
  for (const row of rows) {
    const value = row.effectiveScores[0];
    if (row.effectiveScores.length !== 1 || !validScore(value) || value < 75) {
      streak = [];
      continue;
    }
    streak = [...streak, { sessionId: row.sessionId, sequence: row.sequence, scoredAt: new Date(row.scoredAt), effectiveScore: value }];
    if (streak.length === 3) return decision("trigger", streak);
  }
  return decision("waiting", streak);
}

export type GlobalStage = "exploration" | "strengthening" | "retest";
export type DimensionStage = "unverified" | "pending" | "suspended" | "verified" | "needs_practice";
export type StageEvent = "retest_trigger" | "retest_pass" | "retest_fail" | null;

/** 主阶段与各维复测状态分别计算，未知维度优先。 */
export function resolveGlobalStage(observedDimensions: ReadonlySet<string>, hasPendingRetest: boolean): GlobalStage {
  if (ABILITY_DIMENSIONS.some(dimension => !observedDimensions.has(dimension))) return "exploration";
  return hasPendingRetest ? "retest" : "strengthening";
}

export function resolveDimensionStage(event: StageEvent, hasUnusedQuestion: boolean): DimensionStage {
  if (event === "retest_trigger") return hasUnusedQuestion ? "pending" : "suspended";
  if (event === "retest_pass") return "verified";
  if (event === "retest_fail") return "needs_practice";
  return "unverified";
}

export function judgeRetestResult(effectiveScore: unknown): "pass" | "fail" | null {
  if (!validScore(effectiveScore)) return null;
  return effectiveScore >= 60 ? "pass" : "fail";
}
