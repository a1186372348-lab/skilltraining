import { targetEffectiveScore } from "./score";

export type PackStatus = "active" | "completed" | "abandoned";
export type PackItemState = "locked" | "available" | "in_progress" | "awaiting_score" | "scored" | "inconsistent" | "unavailable";

export interface PackProgressItem {
  orderIndex: number;
  unlockedAt: Date | null;
  /** 会话一旦建立即永久保留；即使关联会话被删除也不能伪装成未开始。 */
  startedAt: Date | null;
  session: {
    id: string;
    state: string;
    finalSubmittedAt: Date | null;
    scoredAt: Date | null;
    scores: { dimension: string; effectiveScore: number }[];
  } | null;
}

export interface PackProgress {
  items: { orderIndex: number; state: PackItemState }[];
  completedCount: number;
  nextUnlockIndex: number | null;
  shouldComplete: boolean;
}

function stateOf(item: PackProgressItem, dimension: string, status: PackStatus): PackItemState {
  if ((item.startedAt === null) !== (item.session === null)) return "inconsistent";
  if (!item.unlockedAt) return item.session ? "inconsistent" : "locked";
  if (!item.session) return status === "active" ? "available" : "unavailable";
  const { session } = item;
  if (session.state === "abandoned" && status === "abandoned" && !session.finalSubmittedAt && !session.scoredAt) return "unavailable";
  if (session.state === "scored") {
    return session.scoredAt && targetEffectiveScore(session.scores, dimension) !== null ? "scored" : "inconsistent";
  }
  if (session.state === "followup" && session.finalSubmittedAt && !session.scoredAt) return "awaiting_score";
  if (["reading", "answering", "followup"].includes(session.state) && !session.finalSubmittedAt && !session.scoredAt) return "in_progress";
  return "inconsistent";
}

/** 从持久化事实恢复顺序，不把丢失或损坏评分视为完成。 */
export function derivePackProgress(status: PackStatus, dimension: string, items: readonly PackProgressItem[]): PackProgress {
  const sorted = [...items].sort((a, b) => a.orderIndex - b.orderIndex);
  const result: PackProgress["items"] = [];
  for (const item of sorted) {
    const expected = result.length;
    const predecessor = result[expected - 1];
    const indexValid = item.orderIndex === expected;
    const predecessorDone = expected === 0 || predecessor?.state === "scored";
    const state = !indexValid || (!predecessorDone && (item.unlockedAt || item.session))
      ? "inconsistent"
      : stateOf(item, dimension, status);
    result.push({ orderIndex: item.orderIndex, state });
  }
  const completedCount = result.filter(item => item.state === "scored").length;
  const validSequence = sorted.length === 5 && sorted.every((item, index) => item.orderIndex === index);
  const nextUnlockIndex = status === "active" && validSequence && result.every(item => item.state !== "inconsistent")
    ? result.find((item, index) => item.state === "locked" && (index === 0 || result[index - 1].state === "scored"))?.orderIndex ?? null
    : null;
  return {
    items: result,
    completedCount,
    nextUnlockIndex,
    shouldComplete: status === "active" && result.length === 5 && completedCount === 5,
  };
}
