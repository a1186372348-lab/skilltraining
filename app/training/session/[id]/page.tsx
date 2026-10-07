import type { Metadata } from "next";

import { TrainingFlow } from "../training-flow";

export const metadata: Metadata = {
  title: "产品训练 · 训练台",
};

/**
 * 训练工作台页（T25 / D27：自 /today 迁移，改为按会话寻址）。
 * 链路：今日案例 → 训练重点 → 主问题 → 参考资料 → 自由回答（渐进提示，D12）
 * → 首次提交（提示按钮消失，D7）→ AI 总监追问（对话气泡）→ 最终提交。
 * 历史列表中「作答中」的旧会话经本页点回继续；基线会话由 TrainingFlow 重定向 /baseline。
 * 内容与交互与迁移前一致，仅路径归属变化。
 */
export default async function TrainingSessionPage({
  params,
}: PageProps<"/training/session/[id]">) {
  const { id } = await params;
  return <TrainingFlow sessionId={id} />;
}
