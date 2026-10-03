import type { Metadata } from "next";

import { HistoryFlow } from "./history-flow";

export const metadata: Metadata = {
  title: "训练历史 · 训练台",
};

/**
 * 训练历史列表页（P5 / T10：US-009）。
 * 按日期倒序的会话卡片列表（日期 / 案例名 / 训练重点 / 有效分摘要 / 状态），
 * 分页浏览；空态引导去 /today。视觉以 prototypes/prototype-b-dashboard.html
 * 为基准，复用侧边栏外壳模式（app/history/shell.tsx）。
 */
export default function HistoryPage() {
  return <HistoryFlow />;
}
