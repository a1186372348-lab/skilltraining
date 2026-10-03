import type { TodayTaskCardData, WeekDayView } from "@/server/modules/dashboard/contract";

/**
 * 首页仪表盘 view-model（T08-Page）：展示判定全部下沉为纯函数，
 * 组件只负责渲染与调用适配层（与 app/today/view-model.ts 同一模式）。
 */

/** 问候语按小时分档 */
export function greetingByHour(hour: number): string {
  if (hour < 5) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

/** 问候副行：有连续天数突出节奏感；新用户引导完成第一题 */
export function greetingSubline(streakDays: number): string {
  return streakDays > 0 ? `今日训练 · 第 ${streakDays} 天` : "今天，从第一题开始";
}

/** 今日任务主按钮：已完成 → 再练一题（加练同等计入画像，D3） */
export function ctaLabel(state: TodayTaskCardData["state"], completed: boolean): string {
  if (completed) return "再练一题";
  return state === "reading" ? "开始今日训练" : "继续今日训练";
}

/** 侧栏今日状态文案（与今日训练页阶段语义一致） */
export function sessionStateLabel(
  state: TodayTaskCardData["state"],
  completed: boolean,
): string {
  if (completed) return "已完成";
  switch (state) {
    case "reading":
      return "待开始";
    case "answering":
      return "作答中";
    case "followup":
      return "追问中";
    case "scored":
      return "已完成";
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 诊断相对日期：今天 / 昨天 / N 天前（日期键为 UTC，差值按整天计） */
export function relativeDayText(dateKey: string, todayKey: string): string {
  const diff = Math.round((Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${dateKey}T00:00:00Z`)) / DAY_MS);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  return `${diff} 天前`;
}

/** 能力条形宽度百分比（0~100，越界收敛，防御脏数据） */
export function scorePercent(score: number): number {
  return Math.min(100, Math.max(0, Math.round(score)));
}

/** 趋势标记：↑ 上升 / ↓ 下降（原型 B 屏 1 仅突出上升趋势） */
export function trendMark(trend: "上升" | "稳定" | "下降" | null): "↑" | "↓" | null {
  if (trend === "上升") return "↑";
  if (trend === "下降") return "↓";
  return null;
}

/** 本周分段样式：已训练主色蓝；今天（未训练）浅蓝提示；其余灰 */
export function weekSegmentClass(day: WeekDayView): string {
  const base = "h-[7px] w-[22px] rounded";
  if (day.trained) {
    return `${base} bg-[#2563EB]${day.isToday ? " ring-[3px] ring-[#60A5FA]/30" : ""}`;
  }
  if (day.isToday) {
    return `${base} bg-[#60A5FA] ring-[3px] ring-[#60A5FA]/30`;
  }
  return `${base} bg-[#E2E8F0]`;
}
