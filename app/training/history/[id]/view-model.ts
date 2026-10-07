import {
  coefficientForHintCount,
  toCaseFieldViews,
  toCaseSourceViews,
  type CaseCitationLink,
  type CaseSourceView,
} from "../../session/view-model";

import type { HistoryHintEventView, HistoryMissingSection } from "../contract";

/**
 * 训练历史详情页视图模型（纯函数，T10 / US-009 / FR-9）。
 * 把"回放数据 → 界面"的全部判定集中在这里，组件只负责渲染；
 * 无 DOM/React 依赖，可在 node 环境用 vitest 直接覆盖。
 */

/** 缺失分区徽标文案（任务契约：单条记录数据缺失时标记而非整页报错） */
export const MISSING_BADGE_TEXT = "记录缺失";

/** 两位补零 */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** ISO 时间 → 本地 YYYY-MM-DD HH:mm；null / 非法输入显示占位文案 */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "时间缺失";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "时间缺失";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 提示事件回放行：第 N 层提示 · 时间 */
export function hintEventLine(event: HistoryHintEventView): string {
  return `第 ${event.layer} 层提示 · ${formatDateTime(event.requestedAt)}`;
}

/** 提示用量摘要：0 层强调完全独立（BR-3 正向反馈） */
export function hintSummaryText(hintCount: number): string {
  if (!Number.isFinite(hintCount) || hintCount <= 0) return "完全独立作答，未使用任何提示";
  return `首次提交前使用了 ${hintCount} 层提示`;
}

/** 独立完成系数说明（BR-2 对照；复用今日训练页同一计算口径） */
export function coefficientCaption(hintCount: number): string {
  return `独立完成系数 ×${coefficientForHintCount(hintCount).toFixed(1)}`;
}

/** 历史详情页案例区标签：与今日训练页共用同一解析逻辑（toCaseFieldViews），各自保留文案 */
const HISTORY_CASE_LABELS = { audience: "服务对象", scenario: "典型场景" } as const;

/**
 * 从案例背景 jsonb 提取案例来源列表（T13 / BR-8）。
 * 服务端历史视图原样下发 case_background jsonb，case_sources 内嵌其中（见 import-questions）；
 * 旧版会话无该键，返回空列表，案例区退化为无引用态。
 * 仅供 caseBackgroundRows 解析引用编号使用（页面不再渲染独立来源列表）。
 */
export function caseSourceRows(raw: unknown): CaseSourceView[] {
  if (typeof raw !== "object" || raw === null) return [];
  return toCaseSourceViews((raw as Record<string, unknown>).case_sources);
}

/**
 * 案例背景展示行：文本 + 结尾内联引用链接（T13 新结构 {text, citations[]}）；
 * 旧版字符串字段（归档会话）原样保留、citations 为空；非对象返回空，非法字段值跳过。
 */
export function caseBackgroundRows(
  raw: unknown,
): { label: string; value: string; citations: CaseCitationLink[] }[] {
  return toCaseFieldViews(raw, caseSourceRows(raw), HISTORY_CASE_LABELS).map((field) => ({
    label: field.label,
    value: field.text,
    citations: field.citations,
  }));
}

/** 分区缺失判定：按 missing 列表渲染缺失徽标 */
export function isSectionMissing(
  missing: readonly HistoryMissingSection[],
  section: HistoryMissingSection,
): boolean {
  return missing.includes(section);
}

/** 答案提交时间小字：已提交给时间，未提交给占位 */
export function answerTimeText(iso: string | null): string {
  return iso ? `提交于 ${formatDateTime(iso)}` : "未提交";
}
