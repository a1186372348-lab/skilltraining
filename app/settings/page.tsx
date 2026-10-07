import type { Metadata } from "next";

import { SettingsFlow } from "./settings-flow";

export const metadata: Metadata = {
  title: "我的 · 训练台",
};

/**
 * 我的页面（P6 /settings，T15：Prd.md 2.3 页面 P6）。
 * 链路：账号信息卡（当前登录邮箱，开发态显示 dev 标识）→ 初始画像卡
 * （查看 + 编辑，预填 GET /api/profile，保存 PUT /api/profile 幂等）
 * → 基础设置占位虚态卡 → 退出登录（POST /api/auth/logout → /login）。
 * 复用侧边栏外壳模式（app/training/session/shell.tsx 的副本，「我的」高亮）。
 */
export default function SettingsPage() {
  return <SettingsFlow />;
}
