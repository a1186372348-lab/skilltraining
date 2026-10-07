import type { AbilityProfileDimensionView } from "@/server/modules/profile/ability";

import type {
  AbilityOverviewData,
  StatsCardData,
  WeekDayView,
} from "./contract";

/**
 * 首页仪表盘装配纯函数（T08 / US-002）。
 *
 * 与 DB 解耦：输入为日期键（YYYY-MM-DD，UTC）与画像视图，输出为卡片数据，
 * 便于 vitest 覆盖连续天数、本周进度、空态（新用户全未知）等核心规则。
 * 日期一律按 UTC 处理，与 training_sessions.date（@db.Date）的零点对齐。
 * （T26：今日任务卡的 buildTodayTaskCard/buildWhyText/parseAbilityTags 已随
 * 「当前训练」三态卡同构下线，题面预览由大厅与工作台承接，D28③。）
 */

/** Date → UTC 日期键（YYYY-MM-DD） */
export function toDateKeyUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 日期键 ±N 天（跨月/跨年/闰年由 Date.UTC 归一化处理） */
export function addDays(dateKey: string, delta: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return toDateKeyUtc(new Date(Date.UTC(year!, month! - 1, day! + delta)));
}

/**
 * 连续训练天数：从「今天」起向前连续计数；今天还没训练时从昨天起计
 * （当天尚未结束，不算断更）；今天和昨天都没有 → 0。
 */
export function computeStreakDays(trainedDateKeys: string[], todayKey: string): number {
  const trained = new Set(trainedDateKeys);
  let cursor = trained.has(todayKey) ? todayKey : addDays(todayKey, -1);
  let streak = 0;
  while (trained.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** 本周分段进度（周一起，共 7 段；今天之后为未来段） */
export function computeWeekProgress(trainedDateKeys: string[], todayKey: string): WeekDayView[] {
  const trained = new Set(trainedDateKeys);
  const [year, month, day] = todayKey.split("-").map(Number);
  // getUTCDay：0=周日 … 6=周六 → 周一为一周起点
  const mondayOffset = (new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay() + 6) % 7;
  const mondayKey = addDays(todayKey, -mondayOffset);
  return Array.from({ length: 7 }, (_, index) => {
    const dateKey = addDays(mondayKey, index);
    return {
      dateKey,
      weekday: index + 1,
      trained: trained.has(dateKey),
      isToday: dateKey === todayKey,
      isFuture: dateKey > todayKey,
    };
  });
}

/** 统计条：连续天数 + 本周 n/7（未来日期不计入完成数，防御脏数据） */
export function buildStatsCard(trainedDateKeys: string[], todayKey: string): StatsCardData {
  const weekDays = computeWeekProgress(trainedDateKeys, todayKey);
  return {
    streakDays: computeStreakDays(trainedDateKeys, todayKey),
    weekTrainedCount: weekDays.filter((day) => day.trained && !day.isFuture).length,
    weekDays,
  };
}

/** 诊断文本截断：trim 后超过上限截断并追加省略号 */
export function truncateText(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}…`;
}

/** 能力总览装配：已观测按分数降序（同分保持维度固定序），未观测列入「待解锁」 */
export function buildAbilityOverview(
  profile: AbilityProfileDimensionView[],
): AbilityOverviewData {
  const observed = profile
    .filter((dimension) => dimension.observed && dimension.currentScore !== null)
    .map((dimension) => ({
      dimension: dimension.dimension,
      score: Math.round(dimension.currentScore!),
      trend: dimension.trend,
    }))
    .sort((a, b) => b.score - a.score);
  const unobserved = profile.filter((dimension) => !dimension.observed).map((d) => d.dimension);
  return {
    unlockedCount: observed.length,
    totalCount: profile.length,
    observed,
    unobserved,
  };
}
