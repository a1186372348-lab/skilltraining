import { formatScore } from "../today/feedback/[id]/view-model";

import type { HistoryPagination, HistoryScoreSummary, HistorySessionState } from "./contract";

/**
 * 训练历史列表页视图模型（纯函数，T10）。
 * 把"历史数据 → 界面"的全部判定集中在这里，组件只负责渲染；
 * 无 DOM/React 依赖，可在 node 环境用 vitest 直接覆盖（同 app/today/view-model.ts 模式）。
 */

/** 每页条数（与路由默认一致；路由上限 50） */
export const HISTORY_PAGE_SIZE = 10;

/** ISO 日期（YYYY-MM-DD）→ 中文日期；非法输入原样返回（防御脏数据） */
export function formatHistoryDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
}

/** 会话状态 → 卡片状态标签 */
export function sessionStateText(state: HistorySessionState): string {
  switch (state) {
    case "reading":
      return "进行中";
    case "answering":
      return "作答中";
    case "followup":
      return "追问中";
    case "scored":
      return "已完成";
  }
}

/** 列表卡片有效分摘要：各维度有效分用 · 连接；未评分显示占位文案 */
export function scoreSummaryText(scores: HistoryScoreSummary[]): string {
  if (scores.length === 0) return "暂无评分";
  return scores
    .map((score) => `${score.dimension} ${formatScore(score.effectiveScore)}`)
    .join(" · ");
}

/** 分页判定：是否有上一页 / 下一页 */
export function hasPrevPage(page: number): boolean {
  return page > 1;
}

export function hasNextPage(page: number, totalPages: number): boolean {
  return page < totalPages;
}

/** 分页信息小字；空态不显示页码 */
export function paginationInfoText(pagination: HistoryPagination): string {
  if (pagination.total === 0) return "暂无训练记录";
  return `第 ${pagination.page} / ${pagination.totalPages} 页 · 共 ${pagination.total} 次训练`;
}

/** 侧栏底部计数文案 */
export function trainingCountText(total: number): string {
  return total === 0 ? "暂无训练记录" : `共 ${total} 次训练`;
}
