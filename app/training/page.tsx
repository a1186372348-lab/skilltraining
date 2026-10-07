import type { Metadata } from "next";

import { TrainingHubFlow } from "./hub-flow";

export const metadata: Metadata = {
  title: "产品训练 · 训练台",
};

/**
 * 产品训练大厅（T25 / D27 模块主页）：顶部「当前训练」卡三态 + 下方训练历史列表。
 * 视觉与信息密度以 prototypes/prototype-training-hub.html 为准（产品负责人已拍板）；
 * 外壳与导航惯例参照现有 profile/history 页。
 */
export default function TrainingHubPage() {
  return <TrainingHubFlow />;
}
