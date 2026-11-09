import type { GlobalStage } from "./judge";

export type StageStatus = "unverified" | "pending" | "suspended" | "verified" | "needs_practice" | "needs_recovery";
export type StageReason = "no_candidate" | "reserved_by_pack" | "session_missing" | "invalid_score" | "inconsistent";

export interface StageDimensionView {
  dimension: string;
  observed: boolean;
  status: StageStatus;
  consecutive: number | null;
  triggerId: string | null;
  activeSessionId: string | null;
  activeSessionStatus: "in_progress" | "awaiting_score" | null;
  reason: StageReason | null;
}

export interface StageTimelineEvent {
  id: string;
  dimension: string;
  type: "retest_trigger" | "retest_pass" | "retest_fail";
  createdAt: string;
  resultEffectiveScore: number | null;
}

export interface StageOverview {
  stage: GlobalStage;
  baselineCompleted: boolean;
  dimensions: StageDimensionView[];
  timeline: StageTimelineEvent[];
}

export type RetestStart =
  | { state: "ready"; triggerId: string; dimension: string; sessionId: string; sessionState: string; awaitingScore: boolean }
  | { state: "suspended"; triggerId: string; dimension: string; reason: "no_candidate" | "reserved_by_pack" }
  | { state: "needs_recovery"; triggerId: string; dimension: string; reason: "session_missing" | "invalid_score" | "inconsistent" }
  | { state: "settled"; triggerId: string; dimension: string; outcome: "pass" | "fail"; sessionId: string | null };
