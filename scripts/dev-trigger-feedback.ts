// 反馈触发与轮询运维脚本（T36：补救「终答已提交但评分长时间未完成」的会话）
// 用法：
//   node --env-file=.env scripts/dev-trigger-feedback.ts <sessionId> [baseUrl]
// 行为：
//   - 为会话归属用户现场签发会话 cookie（与 server/modules/auth/session.ts 同一结构：
//     base64url(payload) + "." + base64url(HMAC-SHA256(AUTH_SECRET, payload))，密钥不打印）；
//   - 请求运行中的开发服务器反馈端点（默认 http://localhost:3000），懒触发评分
//     （幂等，与服务端 inflight 去重共存，撞车安全）；
//   - 每 5 秒轮询直至 ready（打印各维度有效分）或报错（打印 code/message），总超时 6 分钟；
//   - 触发的是真实 AI 评分（DeepSeek，D39），产生少量 token 消耗。
// 备注：内联签发逻辑而非复用 auth 模块——服务端模块内部为无扩展名相对导入，
//  plain node 直跑 TS 无法解析（本脚本须与 import-content.ts 一样可直接 node 运行）。
import { createHmac } from "node:crypto";

import { prisma } from "../server/lib/prisma.ts";

const sessionId = process.argv[2]?.trim();
const baseUrl = (process.argv[3] ?? "http://localhost:3000").replace(/\/+$/, "");
if (!sessionId) {
  console.error("用法：node --env-file=.env scripts/dev-trigger-feedback.ts <sessionId> [baseUrl]");
  process.exit(1);
}
const secret = process.env.AUTH_SECRET?.trim();
if (!secret) {
  console.error("缺少环境变量 AUTH_SECRET（需与开发服务器同源，经 --env-file=.env 注入）");
  process.exit(1);
}

const session = await prisma.trainingSession.findUnique({
  where: { id: sessionId },
  include: { user: true },
});
await prisma.$disconnect();
if (!session) {
  console.error(`会话不存在：${sessionId}`);
  process.exit(1);
}

const body = Buffer.from(
  JSON.stringify({
    sub: session.userId,
    email: session.user.email,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  }),
).toString("base64url");
const sig = createHmac("sha256", secret).update(body).digest("base64url");
const cookie = `st_session=${body}.${sig}`;

const deadline = Date.now() + 6 * 60 * 1000;
const startedAt = Date.now();
for (;;) {
  const res = await fetch(`${baseUrl}/api/training/${sessionId}/feedback`, {
    headers: { cookie },
  });
  const json = (await res.json()) as {
    success: boolean;
    data?: { status: string; scores?: { dimension: string; effectiveScore: number }[] };
    error?: { code: string; message: string };
  };
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  if (!res.ok || !json.success) {
    console.error(`[${elapsed}s] 请求失败 HTTP ${res.status}：${json.error?.code ?? ""} ${json.error?.message ?? ""}`);
    process.exit(1);
  }
  if (json.data?.status === "ready") {
    console.log(`[${elapsed}s] 评分就绪：`);
    for (const row of json.data.scores ?? []) {
      console.log(`- ${row.dimension}: 有效分 ${row.effectiveScore}`);
    }
    process.exit(0);
  }
  console.log(`[${elapsed}s] 评分中…`);
  if (Date.now() > deadline) {
    console.error("超过 6 分钟仍未就绪，退出（服务端可能持续重试中，可稍后重跑本脚本）");
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
