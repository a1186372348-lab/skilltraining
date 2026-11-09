import { buildPackDiagnosis, type PackDiagnosis } from "./diagnosis";
import { PACK_ERROR_CODES, PackError } from "./errors";
import { derivePackProgress, type PackItemState, type PackStatus } from "./progress";
import type { PackRecord } from "./repository";
import { targetEffectiveScore } from "./score";
import type { PackTier } from "./selection";

export interface PackItemView {
  orderIndex: number;
  questionId: string;
  caseTitle: string;
  targetTier: PackTier;
  actualTier: PackTier;
  actualDifficulty: number;
  substituted: boolean;
  state: PackItemState;
  unavailableReason: "question_unavailable" | null;
  sessionId: string | null;
  effectiveScore: number | null;
}

export interface PackDetail {
  id: string;
  dimension: string;
  status: PackStatus;
  createdAt: Date;
  endedAt: Date | null;
  items: PackItemView[];
  diagnosis: PackDiagnosis;
}

/** 不能只相信外键；来源、用户及题目都必须同时匹配。 */
export function assertPackIntegrity(pack: PackRecord): void {
  const validItems = pack.items.length === 5 && pack.items.every((item, index) => item.orderIndex === index);
  const validOwners = pack.items.every(({ session, questionId }) => !session || (
    session.userId === pack.userId && session.questionId === questionId &&
    session.sourceType === "pack" && session.sourceId === pack.id
  ));
  if (!validItems || !validOwners) {
    throw new PackError(PACK_ERROR_CODES.ITEM_INCONSISTENT, 409, "训练包数据不完整，请联系支持恢复");
  }
}

/** 输出仅含题目标题及可见成绩，不返回题目标准答案、提示树或 rubric。 */
export function packDetail(pack: PackRecord): PackDetail {
  assertPackIntegrity(pack);
  const progress = derivePackProgress(pack.status, pack.dimension, pack.items);
  const items = pack.items.map((item, index): PackItemView => {
    const unavailable = !item.session && (item.question.status !== "published" || item.question.kind !== "daily");
    const state = unavailable && progress.items[index].state === "available" ? "unavailable" : progress.items[index].state;
    const score = state === "scored" && item.session ? targetEffectiveScore(item.session.scores, pack.dimension) : null;
    return {
      orderIndex: item.orderIndex, questionId: item.questionId, caseTitle: item.question.caseTitle,
      targetTier: item.targetTier, actualTier: item.actualTier, actualDifficulty: item.actualDifficulty,
      substituted: item.actualTier !== item.targetTier, state,
      unavailableReason: unavailable ? "question_unavailable" : null,
      sessionId: item.session?.id ?? null, effectiveScore: score,
    };
  });
  return {
    id: pack.id, dimension: pack.dimension, status: pack.status,
    createdAt: pack.createdAt, endedAt: pack.endedAt, items,
    diagnosis: buildPackDiagnosis(pack.dimension, pack.items),
  };
}
