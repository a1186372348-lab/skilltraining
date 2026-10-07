import type { Metadata } from "next";

import { FeedbackFlow } from "./feedback-flow";

export const metadata: Metadata = {
  title: "训练反馈 · 训练台",
};

/**
 * 训练反馈页（P4 / T07：US-007，产品的"情感峰值页"；T25 / D27 自 /today/feedback/[id] 迁移）。
 * 链路：有效得分行（含"原始分 × 系数"小字与"查看计算过程"）→ 最需要优化的
 * 一个问题强调卡 → 下一步卡 → 星级问卷（D16：每 5 次训练追加周期性一问）
 * → 双按钮（查看能力画像 / 再练一题）。
 * 评分进行中显示"总监评分中"等待态并轮询（真实延迟 35~49 秒，R5 异步设计）。
 * 视觉以 prototypes/prototype-b-dashboard.html 为基准，复用侧边栏外壳。
 * 内容与交互与迁移前一致，仅路径归属变化。
 */
export default async function FeedbackPage({
  params,
}: PageProps<"/training/feedback/[id]">) {
  const { id } = await params;
  return <FeedbackFlow sessionId={id} />;
}
