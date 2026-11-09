import { expect, it } from "vitest";
import { dimensionStatusText, stageName, stageReason, timelineText } from "./view-model";

it("没有候选题时只说明补题后可重试，不承诺一定出题", () => {
  expect(stageReason("no_candidate")).toBe("暂无可用题，补题后可重试复测。");
});

it("三阶段和各维度状态给出清晰文案", () => {
  expect([stageName("exploration"), stageName("strengthening"), stageName("retest")]).toEqual(["探索期", "强化期", "复测期"]);
  expect([dimensionStatusText("unverified"), dimensionStatusText("pending"), dimensionStatusText("suspended"), dimensionStatusText("verified"), dimensionStatusText("needs_practice"), dimensionStatusText("needs_recovery")]).toEqual(["持续训练", "待复测", "复测挂起", "已通过", "复测未通过 · 继续强化", "状态待恢复"]);
});

it("题量、预留和数据恢复原因不混淆，时间线显示实际分数并保留零分", () => {
  expect(stageReason("no_candidate")).toContain("暂无可用题");
  expect(stageReason("reserved_by_pack")).toContain("训练包预留");
  expect(stageReason("session_missing")).toContain("会话");
  expect(stageReason("invalid_score")).toContain("评分");
  expect(stageReason("inconsistent")).toContain("待恢复");
  expect(stageReason(null)).toBe("");
  const entry = { id: "e", dimension: "用户理解", createdAt: "2026-11-03T00:00:00Z" };
  expect(timelineText({ ...entry, type: "retest_trigger", resultEffectiveScore: null })).toContain("复测已触发");
  expect(timelineText({ ...entry, type: "retest_pass", resultEffectiveScore: 60 })).toContain("复测通过 · 60 分");
  expect(timelineText({ ...entry, type: "retest_fail", resultEffectiveScore: 0 })).toContain("复测未通过 · 0 分");
});
