import { describe, expect, it } from "vitest";

import { dashboardViewSchema, hubCurrentCardSchema } from "./contract";

// T26 / D28②：hubCurrentCardSchema 是「当前训练」三态卡的出口边界校验
// （与 training/hub-view.ts 的 HubCurrentCard 形状对齐），覆盖三态与非法输入。

describe("hubCurrentCardSchema：当前训练卡三态出口校验（T26）", () => {
  it("进行中：携带阶段（作答中/追问中/评分中）", () => {
    const card = { kind: "in_progress", sessionId: "s-1", caseTitle: "案例", stage: "followup" };
    expect(hubCurrentCardSchema.parse(card)).toEqual(card);
  });

  it("未开始：dateKey 必须为 YYYY-MM-DD", () => {
    expect(hubCurrentCardSchema.parse({ kind: "not_started", dateKey: "2026-10-07" })).toEqual({
      kind: "not_started",
      dateKey: "2026-10-07",
    });
    expect(
      hubCurrentCardSchema.safeParse({ kind: "not_started", dateKey: "10月7日" }).success,
    ).toBe(false);
  });

  it("已完成：携带得分摘要；未知 kind 拒绝（快速失败）", () => {
    const card = {
      kind: "completed",
      sessionId: "s-2",
      caseTitle: "案例",
      scores: [{ dimension: "用户理解", effectiveScore: 82 }],
    };
    expect(hubCurrentCardSchema.parse(card)).toEqual(card);
    expect(hubCurrentCardSchema.safeParse({ kind: "unknown" }).success).toBe(false);
  });

  it("dashboardViewSchema 接受 currentTraining 三态与 null（T08 降级约定）", () => {
    const base = {
      todayDateKey: "2026-10-07",
      stats: null,
      ability: null,
      latestDiagnosis: null,
    };
    expect(
      dashboardViewSchema.safeParse({
        ...base,
        currentTraining: { kind: "in_progress", sessionId: "s-1", caseTitle: "案例", stage: "scoring" },
      }).success,
    ).toBe(true);
    expect(dashboardViewSchema.safeParse({ ...base, currentTraining: null }).success).toBe(true);
  });
});
