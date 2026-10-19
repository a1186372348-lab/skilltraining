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
import {
  buildFollowupMessages,
  parseFollowups,
  type FollowupInput,
} from "../server/ai/followup.ts";
import { createAiClientFromEnv } from "../server/ai/client.ts";

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

const input: FollowupInput = {
  mainQuestion: session.question.mainQuestion,
  firstAnswer: session.firstAnswer,
  rubric: session.question.rubric as unknown as FollowupInput["rubric"],
};
const messages = buildFollowupMessages(input);
const client = createAiClientFromEnv();

let drafts: ReturnType<typeof parseFollowups> | null = null;
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
    drafts = parseFollowups(result.content);
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

if (!drafts) {
  console.error("\n全部预算均未成功，未写库。");
  await prisma.$disconnect();
  process.exit(1);
}

const records = drafts.map((draft, index) => ({
  round: index + 1,
  question: draft.question,
  hint: draft.hint,
  hintReleased: false,
}));
await prisma.trainingSession.update({
  where: { id: sessionId },
  data: { followups: records },
});

console.log(`\n已写库（预算 ${usedBudget}，共 ${records.length} 条追问）：`);
for (const record of records) {
  console.log(`- 追问${record.round}：${record.question}`);
  console.log(`  提示：${record.hint || "（无）"}`);
}
await prisma.$disconnect();
