import type { Metadata } from "next";

import { ProfileFlow } from "./profile-flow";

export const metadata: Metadata = {
  title: "能力画像 · 训练台",
};

/**
 * 能力画像页（P2 / T09：US-008 / FR-8 / BR-6）。
 * 链路：顶部洞察条（n/8 已了解 + 下一题优先方向）→ 已观测维度行（分数/观察次数/
 * 趋势火花线/状态标签，弱项展开特征与诊断）→ 未观测维度虚线空态卡 → 整体提示依赖度仪表条。
 * 全部未观测时整页降级为「开始第一次训练后生成」引导态。
 * 视觉以 prototypes/prototype-b-dashboard.html 屏 2 为基准，复用侧边栏外壳模式。
 */
export default function ProfilePage() {
  return <ProfileFlow />;
}
