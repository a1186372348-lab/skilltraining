import type { Metadata } from "next";

import { HistoryDetailFlow } from "./detail-flow";

export const metadata: Metadata = {
  title: "训练回放 · 训练台",
};

/**
 * 训练历史详情回放页（P5 / T10：US-009 / FR-9；T25 / D27 自 /history/[id] 迁移）。
 * 分区顺序：案例 → 我的两版答案 → 提示 → 追问 → 评分 → 反馈；
 * 单条记录数据缺失时标记「记录缺失」而非整页报错；他人记录由 API 返回 404。
 * 视觉以 prototypes/prototype-b-dashboard.html 为基准，复用侧边栏外壳模式。
 * 内容与交互与迁移前一致，仅路径归属变化。
 */
export default async function HistoryDetailPage({
  params,
}: PageProps<"/training/history/[id]">) {
  const { id } = await params;
  return <HistoryDetailFlow sessionId={id} />;
}
