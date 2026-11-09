import type { DimensionStatus, StageKind, StageReason, StageTimelineEntry } from "./contract";

export function stageName(stage: StageKind): string {
  return ({ exploration: "探索期", strengthening: "强化期", retest: "复测期" })[stage];
}

export function stageReason(reason: StageReason): string {
  switch (reason) {
    case "no_candidate": return "暂无可用题，补题后可重试复测。";
    case "reserved_by_pack": return "可用题已由训练包预留，完成或放弃该包后可重试。";
    case "session_missing": return "复测会话暂不可用，请稍后重试。";
    case "invalid_score": return "复测评分暂不可用，请稍后重试。";
    case "inconsistent": return "复测状态待恢复，请稍后重试。";
    default: return "";
  }
}

export function dimensionStatusText(status: DimensionStatus): string {
  return ({ unverified: "持续训练", pending: "待复测", suspended: "复测挂起", verified: "已通过", needs_practice: "复测未通过 · 继续强化", needs_recovery: "状态待恢复" })[status];
}

export function timelineText(entry: StageTimelineEntry): string {
  const action = ({ retest_trigger: "复测已触发", retest_pass: "复测通过", retest_fail: "复测未通过" })[entry.type];
  return `${entry.dimension} · ${action}${entry.resultEffectiveScore === null ? "" : ` · ${entry.resultEffectiveScore} 分`}`;
}
