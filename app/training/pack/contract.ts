/** 专项包接口的 JSON 契约；日期为 ISO 字符串，不是服务端 Date。 */
export type PackTier = "basic" | "advanced" | "challenge";
export type PackItemState = "locked" | "available" | "in_progress" | "awaiting_score" | "scored" | "inconsistent" | "unavailable";
export interface PackItem {
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
  status: "active" | "completed" | "abandoned";
  createdAt: string;
  endedAt: string | null;
  items: PackItem[];
  diagnosis: {
    trajectory: { orderIndex: number; effectiveScore: number | null }[];
    complete: boolean;
    average: number | null;
    trend: "improving" | "stable" | "declining" | null;
    band: "developing" | "building" | "established" | null;
    advice: string | null;
  };
}
