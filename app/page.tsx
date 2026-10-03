import type { Metadata } from "next";

import { HomeDashboard } from "./_dashboard/home-dashboard";

export const metadata: Metadata = {
  title: "首页 · 训练台",
};

/**
 * 首页仪表盘（P1 / T08：US-002）。
 * 首页即成长状态：问候行 + 统计条（连续天数、本周 n/7）、今日任务主卡、
 * 能力总览（含待解锁虚态）、最近一条诊断。
 * 视觉以 prototypes/prototype-b-dashboard.html 屏 1 为基准；
 * 数据经 GET /api/dashboard 装配（app/_dashboard/api.ts 适配层）。
 */
export default function HomePage() {
  return <HomeDashboard />;
}
