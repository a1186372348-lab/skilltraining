import type { Metadata } from "next";

import { TrainingFlow } from "./training-flow";

export const metadata: Metadata = {
  title: "今日训练 · 训练台",
};

/**
 * 今日训练流程页（P3 / T05：US-003~005）。
 * 链路：今日案例 → 训练重点 → 主问题 → 参考资料 → 自由回答（渐进提示，D12）
 * → 首次提交（提示按钮消失，D7）→ AI 总监追问（对话气泡）→ 最终提交。
 * 视觉以 prototypes/prototype-b-dashboard.html 为基准：#F5F6F8 浅灰底、
 * 白色卡片、主色 #2563EB、深色侧边栏；追问气泡吸收原型 C 的呈现。
 * 联调前数据走 app/today/api.ts 的本地 mock 适配层。
 */
export default function TodayPage() {
  return <TrainingFlow />;
}
