import type { Metadata } from "next";

import { BaselineFlow } from "./baseline-flow";

export const metadata: Metadata = {
  title: "能力基线测评 · 训练台",
};

/**
 * 能力基线测评页（T17a / D19 / BR-9）。
 * 注册后第一个接触点：2 道综合题建立初始能力边界，完成后解锁日常训练。
 * 复用今日训练的侧边栏外壳与 TrainingFlow，视觉保持原型 B 设计语言。
 */
export default function BaselinePage() {
  return <BaselineFlow />;
}
