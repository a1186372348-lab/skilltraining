/** 与本人阶段接口的 JSON 契约一致；时间始终为 ISO 字符串。 */
export type StageKind = "exploration" | "strengthening" | "retest";
export type DimensionStatus = "unverified" | "pending" | "suspended" | "verified" | "needs_practice" | "needs_recovery";
export type StageReason = "no_candidate" | "reserved_by_pack" | "session_missing" | "invalid_score" | "inconsistent" | null;
export interface StageDimension {
  dimension: string;
  observed: boolean;
  status: DimensionStatus;
  consecutive: number | null;
  triggerId: string | null;
  activeSessionId: string | null;
  activeSessionStatus: "in_progress" | "awaiting_score" | null;
  reason: StageReason;
}
export interface StageTimelineEntry {
  id: string;
  dimension: string;
  type: "retest_trigger" | "retest_pass" | "retest_fail";
  createdAt: string;
  resultEffectiveScore: number | null;
}
export interface StageOverview {
  stage: StageKind;
  baselineCompleted: boolean;
  dimensions: StageDimension[];
  timeline: StageTimelineEntry[];
}
export type RetestStart =
  | { state: "ready"; triggerId: string; dimension: string; sessionId: string; sessionState: string; awaitingScore: boolean }
  | { state: "suspended"; triggerId: string; dimension: string; reason: "no_candidate" | "reserved_by_pack" }
  | { state: "needs_recovery"; triggerId: string; dimension: string; reason: "session_missing" | "invalid_score" | "inconsistent" }
  | { state: "settled"; triggerId: string; dimension: string; outcome: "pass" | "fail"; sessionId: string | null };
