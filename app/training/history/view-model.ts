import type { HistorySessionState } from "./contract";

/**
 * 训练历史回放共享视图模型（纯函数，T10；T25 / D27 迁入产品训练模块）。
 * 把"历史数据 → 界面"的共用判定集中在这里，组件只负责渲染；
 * 无 DOM/React 依赖，可在 node 环境用 vitest 直接覆盖（同 app/training/session/view-model.ts 模式）。
 *（列表相关函数已随旧 /history 列表页删除——大厅列表判定见 app/training/view-model.ts）
 */

/** ISO 日期（YYYY-MM-DD）→ 中文日期；非法输入原样返回（防御脏数据） */
export function formatHistoryDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
}

/** 会话状态 → 状态标签 */
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
    case "abandoned":
      // T38 / D40：已终止会话只读回放（不评分不计入画像）
      return "已终止";
  }
}
