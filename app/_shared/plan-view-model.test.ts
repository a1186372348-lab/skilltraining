import { describe, expect, it } from "vitest";

import {
  DEEPEN_FREE_TEXT,
  hangingCardFor,
  planPendingHintFor,
  planWeekDays,
  progressTextFor,
  rejectActionFor,
  reviewCardFor,
  statusLabelFor,
  type PlanProgressView,
  type TrainingPlanView,
} from "./plan-view-model";

// 周计划卡 view-model 纯函数单测（T29 切片 5）：排期三态 / 进度展示 / 拒绝撤销态 /
// 周回顾卡映射 / 409 待补测态；不依赖浏览器与数据库。

const WEEK_START = "2026-10-19"; // 周一
const WEDNESDAY = new Date(Date.UTC(2026, 9, 21)); // 本周三（UTC）
const SUNDAY = new Date(Date.UTC(2026, 9, 25)); // 本周日

function makePlan(overrides: Partial<TrainingPlanView> = {}): TrainingPlanView {
  return {
    id: "plan-1",
    weekStartDate: WEEK_START,
    focusDimension: "产品取舍",
    startScore: 55,
    targetScore: 65,
    status: "active",
    reason: "「产品取舍」是你当前最弱的维度（当前 55 分），本周集中攻它，目标 65 分。",
    createdAt: "2026-10-19T08:00:00.000Z",
    ...overrides,
  };
}

const PROGRESS: PlanProgressView = { scoredCount: 3, completedDays: 2 };

describe("planWeekDays：周一至周五排期三态（weekStartDate + 今日 UTC 对齐）", () => {
  it("仅真实完成日期显示完成，过去日期和旧响应不自动完成", () => {
    expect(planWeekDays(WEEK_START, WEDNESDAY, ["2026-10-20"]).map((day) => day.state))
      .toEqual(["missed", "done", "today", "future", "future"]);
    expect(planWeekDays(WEEK_START, SUNDAY).every((day) => day.state === "missed")).toBe(true);
  });
  it("周三视角：周一/周二已完成、周三今日、周四/周五未来；周六日不在排期内", () => {
    const days = planWeekDays(WEEK_START, WEDNESDAY, ["2026-10-19", "2026-10-20"]);
    expect(days).toHaveLength(5); // 周一至周五
    expect(days.map((d) => d.state)).toEqual(["done", "done", "today", "future", "future"]);
    expect(days[0].dateLabel).toBe("10/19");
    expect(days[0].weekdayLabel).toBe("周一");
    expect(days[2].weekdayLabel).toBe("周三");
    expect(days[2].isToday).toBe(true);
  });

  it("周一视角：今日居首，其余未来；周日视角：全部已完成（周日属本周）", () => {
    expect(planWeekDays(WEEK_START, new Date(Date.UTC(2026, 9, 19))).map((d) => d.state)).toEqual([
      "today",
      "future",
      "future",
      "future",
      "future",
    ]);
    expect(planWeekDays(WEEK_START, SUNDAY).every((d) => d.state === "missed")).toBe(true);
  });

  it("跨周查看（下周一看本周）：全部已完成", () => {
    expect(planWeekDays(WEEK_START, new Date(Date.UTC(2026, 9, 26))).every((d) => d.state === "missed")).toBe(true);
  });
});

describe("progressTextFor / statusLabelFor / rejectActionFor：进度与状态呈现", () => {
  it("进度文案：本周已完成 N 天 + 5 格比例（周三视角 done 2 天按位点亮）", () => {
    expect(progressTextFor(PROGRESS)).toBe("本周已完成 2 天 · 已评分 3 题");
    expect(progressTextFor({ scoredCount: 0, completedDays: 0 })).toBe("本周已完成 0 天 · 已评分 0 题");
  });

  it("状态标签：active=生效中 / rejected=已拒绝 / completed=已归档", () => {
    expect(statusLabelFor("active")).toEqual({ label: "生效中", tone: "active" });
    expect(statusLabelFor("rejected").label).toBe("已拒绝");
    expect(statusLabelFor("completed").label).toBe("已归档");
  });

  it("拒绝/撤销：active → reject 动作「拒绝本周计划」；rejected → unreject 动作「撤销拒绝」；completed → null（不可操作）", () => {
    expect(rejectActionFor(makePlan())).toEqual({ action: "reject", label: "拒绝本周计划" });
    expect(rejectActionFor(makePlan({ status: "rejected" }))).toEqual({
      action: "unreject",
      label: "撤销拒绝",
    });
    expect(rejectActionFor(makePlan({ status: "completed" }))).toBeNull();
  });
});

describe("reviewCardFor：周回顾卡数据映射", () => {
  it("正常：完成天数 + 主攻维度有效分变化（含正负号与提升/回落文案）", () => {
    const card = reviewCardFor({
      plan: makePlan({ status: "completed" }),
      scoredCount: 3,
      completedDays: 2,
      startScore: 55,
      latestScore: 62,
      scoreChange: 7,
    });
    expect(card!.title).toContain("周回顾");
    expect(card!.daysText).toBe("本周完成 2 天 · 已评分 3 题");
    expect(card!.scoreText).toContain("55");
    expect(card!.scoreText).toContain("62");
    expect(card!.scoreText).toContain("+7");
    expect(card!.tone).toBe("up");
  });

  it("scoreChange 为 null（最新分未知）→ 兜底文案不崩；下降为 down 态", () => {
    const unknown = reviewCardFor({
      plan: makePlan(),
      scoredCount: 0,
      completedDays: 0,
      startScore: 55,
      latestScore: null,
      scoreChange: null,
    });
    expect(unknown!.scoreText).toContain("暂无"); // 兜底
    expect(unknown!.tone).toBe("flat");

    const down = reviewCardFor({
      plan: makePlan(),
      scoredCount: 1,
      completedDays: 1,
      startScore: 55,
      latestScore: 50,
      scoreChange: -5,
    });
    expect(down!.scoreText).toContain("-5");
    expect(down!.tone).toBe("down");
  });

  it("review 为 null（未生成态）→ 返回 null（不渲染卡）", () => {
    expect(reviewCardFor(null)).toBeNull();
  });
});

describe("planPendingHintFor：409 待补测态映射（D35）", () => {
  it("PROFILE_INCOMPLETE → 待补测引导文案（含基线测评指引）；其他错误码 → null", () => {
    const hint = planPendingHintFor("PROFILE_INCOMPLETE");
    expect(hint).toContain("基线测评");
    expect(hint).toContain("八维");
    expect(planPendingHintFor("PLAN_NOT_FOUND")).toBeNull();
    expect(planPendingHintFor("RATE_LIMITED")).toBeNull();
    expect(planPendingHintFor(null)).toBeNull();
    expect(planPendingHintFor(undefined)).toBeNull();
  });
});

describe("hangingCardFor：首页悬挂计划卡（屏 1 样式）", () => {
  it("active 计划：标题含维度、理由前置、进度条比例 = completedDays/5", () => {
    const card = hangingCardFor(makePlan(), PROGRESS);
    expect(card!.title).toContain("产品取舍");
    expect(card!.body).toBe(makePlan().reason); // 理由前置
    expect(card!.progressText).toBe("本周已完成 2 天");
    expect(card!.ratio).toBeCloseTo(0.4); // 2/5
  });

  it("rejected / completed / 无计划 / 无进度 → null（不悬挂）", () => {
    expect(hangingCardFor(makePlan({ status: "rejected" }), PROGRESS)).toBeNull();
    expect(hangingCardFor(makePlan({ status: "completed" }), PROGRESS)).toBeNull();
    expect(hangingCardFor(null, PROGRESS)).toBeNull();
    expect(hangingCardFor(makePlan(), null)).toBeNull();
  });

  it("加深提示文案常量存在（DEEPEN_FREE_TEXT 供大厅复用）", () => {
    expect(DEEPEN_FREE_TEXT.length).toBeGreaterThan(0);
  });
});
