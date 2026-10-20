// 追问补生成运维脚本（2026-10-07，咖啡题会话追问生成失败的补救 + 截空假说验证）
// 用法：
//   node --env-file=.env scripts/regen-followup.ts <sessionId> [起始预算]
// 行为：
//   - 守卫：会话不存在 / 未提交首答 / 追问非空（拒绝覆盖）→ 退出码 1；
//   - 按预算序列（默认 2048 → 4096）逐级调用 AI 网关生成追问，首次成功即写库；
//   - 推理模型（D39 起 deepseek-flash）：推理 token 计入 max_completion_tokens，
//     预算不足会返回空正文（server/ai/followup.ts 注释记载的已知截断模式），
//     因此逐级上调预算既是诊断也是补救；
//   - 不打印 API Key 与 Rubric 明文；只打印元数据与生成的追问/提示文本（用户本人数据）。
import { prisma } from "../server/lib/prisma.ts";
import { Prisma } from "@prisma/client";
import {
  buildFollowupMessages,
  parseFollowupGateOutput,
  type FollowupGateResult,
  type FollowupInput,
} from "../server/ai/followup.ts";
import { createAiClientFromEnv } from "../server/ai/client.ts";
import { buildFollowupGateDecisionRecord } from "../server/modules/training/today-view.ts";

const sessionId = process.argv[2]?.trim();
if (!sessionId) {
  console.error("用法：node --env-file=.env scripts/regen-followup.ts <sessionId> [起始预算]");
  process.exit(1);
}

const startBudget = Number(process.argv[3]) || 2048;
const budgets = [...new Set([startBudget, 4096])].sort((a, b) => a - b);

const session = await prisma.trainingSession.findUnique({
  where: { id: sessionId },
  include: { question: true },
});
if (!session) {
  console.error(`会话不存在：${sessionId}`);
  process.exit(1);
}
if (!session.firstAnswer) {
  console.error("会话尚未提交首答，无生成依据，退出。");
  process.exit(1);
}
const existing = Array.isArray(session.followups) ? session.followups : [];
if (existing.length > 0) {
  console.error(`会话已有 ${existing.length} 条追问，拒绝覆盖，退出。`);
  process.exit(1);
}

console.log(
  `会话 ${sessionId}（${session.question.caseTitle}）追问为空，开始补生成；预算序列：${budgets.join(" → ")}`,
);

const abilityTags = session.question.abilityTags;
const primaryDimension =
  Array.isArray(abilityTags) && typeof abilityTags[0] === "string" ? abilityTags[0] : undefined;
const input: FollowupInput = {
  mainQuestion: session.question.mainQuestion,
  firstAnswer: session.firstAnswer,
  rubric: session.question.rubric as unknown as FollowupInput["rubric"],
  primaryDimension,
};
const messages = buildFollowupMessages(input);
const client = createAiClientFromEnv();

let gate: FollowupGateResult | null = null;
let usedBudget = 0;
for (const budget of budgets) {
  console.log(`\n[尝试] max_completion_tokens=${budget} …`);
  const startedAt = Date.now();
  try {
    const result = await client.chatCompletion({
      messages,
      temperature: 0.3,
      maxCompletionTokens: budget,
      responseFormat: { type: "json_object" },
    });
    gate = parseFollowupGateOutput(result.content);
    usedBudget = budget;
    console.log(
      `[成功] 耗时 ${Math.round((Date.now() - startedAt) / 1000)}s，` +
        `用量 prompt=${result.usage?.promptTokens ?? "?"} completion=${result.usage?.completionTokens ?? "?"}`,
    );
    break;
  } catch (error) {
    console.log(
      `[失败] 耗时 ${Math.round((Date.now() - startedAt) / 1000)}s，` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

if (!gate) {
  console.error("\n全部预算均未成功，未写库。");
  await prisma.$disconnect();
  process.exit(1);
}

// T35 / D37：闸门判定记录两分支落库（gate_decision 恒为首元素，含判定理由），与失败空数组可区分
if (!gate.shouldFollowup) {
  const decision = buildFollowupGateDecisionRecord(false, gate.reason);
  await prisma.trainingSession.update({
    where: { id: sessionId },
    // Prisma Json 写入类型要求 InputJsonValue：纯数据对象经 unknown 收窄（同 service 落库写法）
    data: { followups: [decision] as unknown as Prisma.InputJsonValue },
  });
  console.log(`\n闸门判定无需追问，已写库 gate_decision 判定记录（预算 ${usedBudget}）：`);
  console.log(`- 判定理由：${gate.reason}`);
  await prisma.$disconnect();
  process.exit(0);
}

const decision = buildFollowupGateDecisionRecord(true, gate.reason);
const records = gate.followups.map((draft, index) => ({
  round: index + 1,
  question: draft.question,
  hint: draft.hint,
  hintReleased: false,
}));
await prisma.trainingSession.update({
  where: { id: sessionId },
  // 判定记录为首元素，追问轮次跟在其后（与 service 落库结构一致）
  data: { followups: [decision, ...records] as unknown as Prisma.InputJsonValue },
});

console.log(`\n已写库（预算 ${usedBudget}，闸门判定追问，共 ${records.length} 条追问）：`);
console.log(`- 判定理由：${gate.reason}`);
for (const record of records) {
  console.log(`- 追问${record.round}：${record.question}`);
  console.log(`  提示：${record.hint || "（无）"}`);
}
await prisma.$disconnect();
