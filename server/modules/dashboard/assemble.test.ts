import { describe, expect, it } from "vitest";

import type { AbilityProfileDimensionView } from "@/server/modules/profile/ability";

import {
  addDays,
  buildAbilityOverview,
  buildStatsCard,
  computeStreakDays,
  computeWeekProgress,
  toDateKeyUtc,
  truncateText,
} from "./assemble";

// T08 首页仪表盘装配纯函数测试（US-002）。
// 日期基准：2026-10-03 为周六；所在周（周一起）为 2026-09-28 ~ 2026-10-04。

const TODAY = "2026-10-03"; // 周六
const WEEK_KEYS = [
  "2026-09-28",
  "2026-09-29",
  "2026-09-30",
  "2026-10-01",
  "2026-10-02",
  "2026-10-03",
  "2026-10-04",
];

/** 构造单维画像视图（未观测维度 currentScore 为 null，对齐 getAbilityProfileView 输出） */
function dimensionView(
  dimension: string,
  currentScore: number | null,
  trend: "上升" | "稳定" | "下降" | null = null,
): AbilityProfileDimensionView {
  const observed = currentScore !== null;
  return {
    dimension,
    observed,
    currentScore,
    observationCount: observed ? 3 : 0,
    hintDependency: observed ? 1.2 : null,
    hintDependencyBand: observed ? "中" : null,
    trend: observed ? trend : null,
    updatedAt: observed ? new Date("2026-10-02T00:00:00Z") : null,
  };
}

describe("toDateKeyUtc / addDays", () => {
  it("Date 转 UTC 日期键", () => {
    expect(toDateKeyUtc(new Date(Date.UTC(2026, 9, 3)))).toBe("2026-10-03");
  });

  it("addDays 支持跨月/跨年/闰年", () => {
    expect(addDays("2026-10-03", -1)).toBe("2026-10-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28"); // 2026 非闰年
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29"); // 2024 闰年
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-09-28", 6)).toBe("2026-10-04");
  });
});

describe("computeStreakDays：按有终答的日期连续计数", () => {
  it("无任何训练 → 0", () => {
    expect(computeStreakDays([], TODAY)).toBe(0);
  });

  it("仅今天训练 → 1", () => {
    expect(computeStreakDays(["2026-10-03"], TODAY)).toBe(1);
  });

  it("今天起向前连续 → 累计", () => {
    expect(computeStreakDays(["2026-10-03", "2026-10-02", "2026-10-01"], TODAY)).toBe(3);
  });

  it("今天未训练但昨天连续 → 从昨天起计（当天还没结束，不算断）", () => {
    expect(computeStreakDays(["2026-10-02", "2026-10-01"], TODAY)).toBe(2);
  });

  it("今天和昨天都未训练 → 0", () => {
    expect(computeStreakDays(["2026-10-01"], TODAY)).toBe(0);
  });

  it("中间断档 → 只计最近一段", () => {
    expect(computeStreakDays(["2026-10-03", "2026-10-01", "2026-09-30"], TODAY)).toBe(1);
  });

  it("重复日期去重；跨月连续", () => {
    expect(computeStreakDays(["2026-10-03", "2026-10-03"], TODAY)).toBe(1);
    expect(computeStreakDays(["2026-10-01", "2026-09-30", "2026-09-29"], "2026-10-01")).toBe(3);
  });
});

describe("computeWeekProgress：本周 n/7（周一起）", () => {
  it("空周：7 天、周一开头、今天/未来标记正确", () => {
    const days = computeWeekProgress([], TODAY);
    expect(days.map((d) => d.dateKey)).toEqual(WEEK_KEYS);
    expect(days.map((d) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(days.every((d) => !d.trained)).toBe(true);
    expect(days.findIndex((d) => d.isToday)).toBe(5); // 周六
    expect(days.filter((d) => d.isFuture).map((d) => d.dateKey)).toEqual(["2026-10-04"]);
  });

  it("按日期键标记已训练", () => {
    const days = computeWeekProgress(["2026-09-28", "2026-10-03"], TODAY);
    expect(days[0]?.trained).toBe(true);
    expect(days[5]?.trained).toBe(true);
    expect(days[1]?.trained).toBe(false);
  });

  it("周日为一周最后一天", () => {
    const days = computeWeekProgress([], "2026-10-04"); // 周日
    expect(days[0]?.dateKey).toBe("2026-09-28");
    expect(days[6]?.dateKey).toBe("2026-10-04");
    expect(days[6]?.isToday).toBe(true);
    expect(days.every((d) => !d.isFuture)).toBe(true);
  });
});

describe("buildStatsCard", () => {
  it("组合连续天数与本周进度", () => {
    const stats = buildStatsCard(["2026-10-02", "2026-10-03"], TODAY);
    expect(stats.streakDays).toBe(2);
    expect(stats.weekTrainedCount).toBe(2);
    expect(stats.weekDays).toHaveLength(7);
  });

  it("新用户全未知：0 天、0/7", () => {
    const stats = buildStatsCard([], TODAY);
    expect(stats.streakDays).toBe(0);
    expect(stats.weekTrainedCount).toBe(0);
  });

  it("未来日期不计入本周完成数（防御）", () => {
    const stats = buildStatsCard(["2026-10-04"], TODAY);
    expect(stats.weekTrainedCount).toBe(0);
  });
});

describe("truncateText：诊断截断", () => {
  it("短文本原样返回并 trim", () => {
    expect(truncateText("  短文本  ", 90)).toBe("短文本");
  });

  it("恰好等于上限不截断", () => {
    const text = "一".repeat(90);
    expect(truncateText(text, 90)).toBe(text);
  });

  it("超过上限截断并追加省略号", () => {
    const text = "一".repeat(100);
    const result = truncateText(text, 90);
    expect(result).toHaveLength(91);
    expect(result.endsWith("…")).toBe(true);
    expect(result.startsWith("一".repeat(90))).toBe(true);
  });
});

describe("buildAbilityOverview：能力总览（含待解锁虚态）", () => {
  it("已观测按分数降序、取整；未观测列入待解锁", () => {
    const overview = buildAbilityOverview([
      dimensionView("问题定义", 68.4),
      dimensionView("用户理解", null),
      dimensionView("根因分析", null),
      dimensionView("产品价值判断", 75.6, "上升"),
      dimensionView("方案设计", null),
      dimensionView("产品取舍", 61.2),
      dimensionView("指标与验证", null),
      dimensionView("产品表达", null),
    ]);
    expect(overview.totalCount).toBe(8);
    expect(overview.unlockedCount).toBe(3);
    expect(overview.observed.map((o) => o.dimension)).toEqual([
      "产品价值判断",
      "问题定义",
      "产品取舍",
    ]);
    expect(overview.observed.map((o) => o.score)).toEqual([76, 68, 61]);
    expect(overview.observed[0]?.trend).toBe("上升");
    expect(overview.unobserved).toEqual([
      "用户理解",
      "根因分析",
      "方案设计",
      "指标与验证",
      "产品表达",
    ]);
  });

  it("新用户全未知：0/8、无条形", () => {
    const overview = buildAbilityOverview([
      dimensionView("问题定义", null),
      dimensionView("用户理解", null),
    ]);
    expect(overview.unlockedCount).toBe(0);
    expect(overview.observed).toEqual([]);
    expect(overview.unobserved).toEqual(["问题定义", "用户理解"]);
  });
});
