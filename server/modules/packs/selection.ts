import { PACK_ERROR_CODES, PackError } from "./errors";

export type PackTier = "basic" | "advanced" | "challenge";

export interface PackQuestionCandidate {
  id: string;
  difficulty: number;
  abilityTags: unknown;
  kind: string;
  status: string;
}

export interface SelectedPackQuestion {
  questionId: string;
  targetTier: PackTier;
  actualTier: PackTier;
  actualDifficulty: number;
  substituted: boolean;
}

const TARGET_TIERS: readonly PackTier[] = ["basic", "basic", "advanced", "advanced", "challenge"];
const TIER_RANK: Record<PackTier, number> = { basic: 0, advanced: 1, challenge: 2 };

function tierOf(difficulty: number): PackTier {
  return difficulty <= 2 ? "basic" : difficulty === 3 ? "advanced" : "challenge";
}

function validCandidate(item: PackQuestionCandidate, dimension: string, practiced: ReadonlySet<string>): boolean {
  return typeof item.id === "string" && item.id.length > 0 && item.status === "published" && item.kind === "daily" &&
    Number.isInteger(item.difficulty) && item.difficulty >= 1 && item.difficulty <= 5 &&
    Array.isArray(item.abilityTags) && item.abilityTags.includes(dimension) && !practiced.has(item.id);
}

function compareQuestion(a: PackQuestionCandidate, b: PackQuestionCandidate): number {
  return a.difficulty - b.difficulty || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

interface Assignment {
  cost: number;
  slots: (PackQuestionCandidate | null)[];
}

function better(next: Assignment, current: Assignment | undefined): boolean {
  if (!current || next.cost !== current.cost) return !current || next.cost < current.cost;
  for (let i = 0; i < TARGET_TIERS.length; i++) {
    const a = next.slots[i];
    const b = current.slots[i];
    if (!a || !b) continue;
    const compare = compareQuestion(a, b);
    if (compare !== 0) return compare < 0;
  }
  return false;
}

function assignQuestions(candidates: readonly PackQuestionCandidate[]): Assignment {
  let states = new Map<number, Assignment>([[0, { cost: 0, slots: TARGET_TIERS.map(() => null) }]]);
  for (const question of candidates) {
    const nextStates = new Map(states);
    for (const [mask, previous] of states) {
      for (let i = 0; i < TARGET_TIERS.length; i++) {
        if ((mask & (1 << i)) !== 0) continue;
        const target = TARGET_TIERS[i];
        const slots = previous.slots.map((item, index) => index === i ? question : item);
        const next = { cost: previous.cost + Math.abs(TIER_RANK[tierOf(question.difficulty)] - TIER_RANK[target]), slots };
        const nextMask = mask | (1 << i);
        if (better(next, nextStates.get(nextMask))) nextStates.set(nextMask, next);
      }
    }
    states = nextStates;
  }
  const result = states.get((1 << TARGET_TIERS.length) - 1);
  if (!result) throw new PackError(PACK_ERROR_CODES.INSUFFICIENT_QUESTIONS, 422, "该维度可用未练题不足五道");
  return result;
}

/** 最小化全包层级偏移；同成本按难度与题目 ID 稳定选择。 */
export function selectPackQuestions(
  candidates: readonly PackQuestionCandidate[],
  dimension: string,
  practicedQuestionIds: ReadonlySet<string>,
): SelectedPackQuestion[] {
  const valid = candidates.filter(item => validCandidate(item, dimension, practicedQuestionIds)).sort(compareQuestion);
  const unique = [...new Map(valid.map(item => [item.id, item])).values()];
  if (unique.length < TARGET_TIERS.length) throw new PackError(PACK_ERROR_CODES.INSUFFICIENT_QUESTIONS, 422, "该维度可用未练题不足五道");
  return assignQuestions(unique).slots.map((question, index) => {
    if (!question) throw new Error("专项组题结果不完整");
    const actualTier = tierOf(question.difficulty);
    const targetTier = TARGET_TIERS[index];
    return { questionId: question.id, targetTier, actualTier, actualDifficulty: question.difficulty, substituted: actualTier !== targetTier };
  });
}
