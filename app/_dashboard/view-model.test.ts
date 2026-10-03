import { describe, expect, it } from "vitest";

import {
  ctaLabel,
  greetingByHour,
  greetingSubline,
  relativeDayText,
  scorePercent,
  sessionStateLabel,
  trendMark,
  weekSegmentClass,
} from "./view-model";

// T08 首页仪表盘 view-model 纯函数测试（展示判定全部下沉到这里，组件只渲染）。

describe("greetingByHour：问候语按小时分档", () => {
  it.each([
    [2, "夜深了"],
    [8, "早上好"],
    [12, "中午好"],
    [15, "下午好"],
    [21, "晚上好"],
  ])("%i 点 → %s", (hour, expected) => {
    expect(greetingByHour(hour)).toBe(expected);
  });

  it("边界：5/11/14/18 点换挡", () => {
    expect(greetingByHour(4)).toBe("夜深了");
    expect(greetingByHour(5)).toBe("早上好");
    expect(greetingByHour(10)).toBe("早上好");
    expect(greetingByHour(11)).toBe("中午好");
    expect(greetingByHour(13)).toBe("中午好");
    expect(greetingByHour(14)).toBe("下午好");
    expect(greetingByHour(17)).toBe("下午好");
    expect(greetingByHour(18)).toBe("晚上好");
  });
});

describe("greetingSubline：问候副行", () => {
  it("有连续天数 → 第 N 天", () => {
    expect(greetingSubline(12)).toContain("第 12 天");
  });

  it("新用户 → 引导文案", () => {
    expect(greetingSubline(0)).toContain("第一题");
  });
});

describe("ctaLabel：今日任务主按钮", () => {
  it("未完成：reading → 开始今日训练；进行中 → 继续今日训练", () => {
    expect(ctaLabel("reading", false)).toBe("开始今日训练");
    expect(ctaLabel("answering", false)).toBe("继续今日训练");
    expect(ctaLabel("followup", false)).toBe("继续今日训练");
  });

  it("已完成 → 再练一题", () => {
    expect(ctaLabel("scored", true)).toBe("再练一题");
    expect(ctaLabel("followup", true)).toBe("再练一题");
  });
});

describe("sessionStateLabel：侧栏今日状态", () => {
  it("按会话状态映射；已完成优先", () => {
    expect(sessionStateLabel("reading", false)).toBe("待开始");
    expect(sessionStateLabel("answering", false)).toBe("作答中");
    expect(sessionStateLabel("followup", false)).toBe("追问中");
    expect(sessionStateLabel("scored", true)).toBe("已完成");
    expect(sessionStateLabel("followup", true)).toBe("已完成");
  });
});

describe("relativeDayText：诊断相对日期", () => {
  const today = "2026-10-03";
  it("今天 / 昨天 / N 天前", () => {
    expect(relativeDayText("2026-10-03", today)).toBe("今天");
    expect(relativeDayText("2026-10-02", today)).toBe("昨天");
    expect(relativeDayText("2026-09-30", today)).toBe("3 天前");
  });

  it("跨月计算；未来日期按今天处理（防御）", () => {
    expect(relativeDayText("2026-09-28", today)).toBe("5 天前");
    expect(relativeDayText("2026-10-04", today)).toBe("今天");
  });
});

describe("scorePercent：能力条形宽度", () => {
  it("0~100 原样取整", () => {
    expect(scorePercent(61)).toBe(61);
    expect(scorePercent(75.6)).toBe(76);
  });

  it("越界收敛到 0~100（防御脏数据）", () => {
    expect(scorePercent(-3)).toBe(0);
    expect(scorePercent(128)).toBe(100);
  });
});

describe("trendMark：趋势标记", () => {
  it("上升 → ↑；下降 → ↓；稳定/无 → 无标记", () => {
    expect(trendMark("上升")).toBe("↑");
    expect(trendMark("下降")).toBe("↓");
    expect(trendMark("稳定")).toBeNull();
    expect(trendMark(null)).toBeNull();
  });
});

describe("weekSegmentClass：本周分段样式", () => {
  const base = { dateKey: "2026-10-03", weekday: 6 };

  it("已训练 → 主色；今天叠加高亮环", () => {
    expect(weekSegmentClass({ ...base, trained: true, isToday: false, isFuture: false })).toContain(
      "#2563EB",
    );
    const today = weekSegmentClass({ ...base, trained: true, isToday: true, isFuture: false });
    expect(today).toContain("#2563EB");
    expect(today).toContain("ring");
  });

  it("今天未训练 → 浅蓝提示；未来/过去未训练 → 灰", () => {
    expect(weekSegmentClass({ ...base, trained: false, isToday: true, isFuture: false })).toContain(
      "#60A5FA",
    );
    expect(weekSegmentClass({ ...base, trained: false, isToday: false, isFuture: true })).toContain(
      "#E2E8F0",
    );
    expect(weekSegmentClass({ ...base, trained: false, isToday: false, isFuture: false })).toContain(
      "#E2E8F0",
    );
  });
});
