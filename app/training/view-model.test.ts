import { describe, expect, it } from "vitest";

import type { HubInProgressCard, HubHistoryItem, HubSessionStage } from "./contract";
import {
  actionNoteFor,
  canRestartFor,
  continueActionFor,
  currentBadgeText,
  formatHubDateKey,
  formatHubTime,
  historyHrefFor,
  historyStatusFor,
  hubStageText,
  progressLineFor,
  sidebarStageText,
} from "./view-model";

// 产品训练大厅前端视图模型纯函数测试（T25 / D27）：
// 阶段文案映射、当前卡徽章与继续按钮模型、历史行状态徽章与跳转路由、
// 日期/时间格式化、侧栏今日状态、空历史文案。

const ALL_STAGES: HubSessionStage[] = ["answering", "followup", "scoring"];

function inProgress(stage: HubSessionStage, sessionId = "s-1"): HubInProgressCard {
  return { kind: "in_progress", sessionId, caseTitle: "案例一", stage };
}

function item(overrides: Partial<HubHistoryItem> = {}): HubHistoryItem {
  return {
    sessionId: "s-1",
    caseTitle: "案例一",
    isExtra: false,
    state: "scored",
    hasFinalAnswer: true,
    abilityTags: ["用户理解"],
    scores: [],
    startedAt: "2026-10-07T08:00:00.000Z",
    ...overrides,
  };
}

describe("阶段文案映射", () => {
  it("hubStageText：作答中 / 追问中 / 评分中", () => {
    expect(hubStageText("answering")).toBe("作答中");
    expect(hubStageText("followup")).toBe("追问中");
    expect(hubStageText("scoring")).toBe("评分中");
  });

  it("进行中卡徽章：进行中 · {阶段}", () => {
    expect(currentBadgeText(inProgress("answering"))).toBe("进行中 · 作答中");
    expect(currentBadgeText(inProgress("followup"))).toBe("进行中 · 追问中");
    expect(currentBadgeText(inProgress("scoring"))).toBe("进行中 · 评分中");
  });

  it("三阶段的进度行与操作提示均有文案（不留空）", () => {
    for (const stage of ALL_STAGES) {
      expect(progressLineFor(stage).length).toBeGreaterThan(0);
      expect(actionNoteFor(stage).length).toBeGreaterThan(0);
    }
  });

  it("追问阶段沿用原型拍板文案", () => {
    expect(progressLineFor("followup")).toBe("已完成首次作答，等待你回应总监追问");
    expect(actionNoteFor("followup")).toBe("追问不扣分，放心补充你的判断");
  });
});

describe("进行中卡继续按钮模型", () => {
  it("作答中 / 追问中 →「继续训练」跳对应工作台", () => {
    expect(continueActionFor(inProgress("answering", "s-9"))).toEqual({
      label: "继续训练",
      href: "/training/session/s-9",
    });
    expect(continueActionFor(inProgress("followup", "s-9")).href).toBe("/training/session/s-9");
  });

  it("评分中 →「查看评分进度」跳反馈页（评分等待态由反馈页承接）", () => {
    expect(continueActionFor(inProgress("scoring", "s-9"))).toEqual({
      label: "查看评分进度",
      href: "/training/feedback/s-9",
    });
  });
});

describe("进行中卡「重启训练」可见性（T38 / D40）", () => {
  it("作答中 / 追问中可重启（未提交终答可终止）", () => {
    expect(canRestartFor("answering")).toBe(true);
    expect(canRestartFor("followup")).toBe(true);
  });

  it("评分中不可重启（已提交终答，服务端一律 409，入口不展示）", () => {
    expect(canRestartFor("scoring")).toBe(false);
  });
});

describe("日期与时间格式化", () => {
  it("formatHubDateKey：YYYY-MM-DD → 中文日期 + 星期（UTC 口径，防时区漂移）", () => {
    expect(formatHubDateKey("2026-10-07")).toBe("2026年10月7日 星期三");
    expect(formatHubDateKey("2026-01-15")).toBe("2026年1月15日 星期四");
  });

  it("formatHubDateKey：非法输入原样返回（防御脏数据）", () => {
    expect(formatHubDateKey("bad")).toBe("bad");
  });

  it("formatHubTime：与今天同本地日 → 今天 HH:mm", () => {
    const now = new Date(2026, 9, 7, 18, 0);
    expect(formatHubTime(new Date(2026, 9, 7, 16, 5).toISOString(), now)).toBe("今天 16:05");
    expect(formatHubTime(new Date(2026, 9, 7, 0, 5).toISOString(), now)).toBe("今天 00:05");
  });

  it("formatHubTime：当年非当天 → M月D日；跨年 → YYYY年M月D日", () => {
    const now = new Date(2026, 9, 7, 18, 0);
    expect(formatHubTime(new Date(2026, 9, 5, 9, 40).toISOString(), now)).toBe("10月5日");
    expect(formatHubTime(new Date(2025, 11, 31, 9, 40).toISOString(), now)).toBe("2025年12月31日");
  });

  it("formatHubTime：非法时间显示占位文案", () => {
    expect(formatHubTime("not-a-date", new Date())).toBe("时间缺失");
  });
});

describe("历史行状态徽章与跳转", () => {
  it("已完成 → 绿徽章，跳只读详情 /training/history/[id]", () => {
    expect(historyStatusFor(item({ state: "scored" }))).toEqual({ text: "已完成", tone: "done" });
    expect(historyHrefFor(item({ state: "scored" }))).toBe("/training/history/s-1");
  });

  it("reading / answering → 作答中（灰徽章），跳工作台继续作答", () => {
    for (const state of ["reading", "answering"] as const) {
      const target = item({ state, hasFinalAnswer: false });
      expect(historyStatusFor(target)).toEqual({ text: "作答中", tone: "doing" });
      expect(historyHrefFor(target)).toBe("/training/session/s-1");
    }
  });

  it("followup 未交终答 → 追问中（灰）；已交终答未评分 → 评分中（蓝），均跳工作台", () => {
    expect(historyStatusFor(item({ state: "followup", hasFinalAnswer: false }))).toEqual({
      text: "追问中",
      tone: "doing",
    });
    const scoring = item({ state: "followup", hasFinalAnswer: true });
    expect(historyStatusFor(scoring)).toEqual({ text: "评分中", tone: "scoring" });
    expect(historyHrefFor(scoring)).toBe("/training/session/s-1");
  });

  it("已终止（T38 / D40）→「已终止」徽章，跳只读详情（不可回工作台）", () => {
    const abandoned = item({ state: "abandoned", hasFinalAnswer: false });
    expect(historyStatusFor(abandoned)).toEqual({ text: "已终止", tone: "abandoned" });
    expect(historyHrefFor(abandoned)).toBe("/training/history/s-1");
  });
});

describe("侧栏今日状态", () => {
  it("进行中 → 阶段文案；未开始 → 待开始；已完成 → 已完成", () => {
    expect(sidebarStageText(inProgress("followup"))).toBe("追问中");
    expect(sidebarStageText({ kind: "not_started", dateKey: "2026-10-07" })).toBe("待开始");
    expect(
      sidebarStageText({ kind: "completed", sessionId: "s-1", caseTitle: "案例一", scores: [] }),
    ).toBe("已完成");
  });
});
