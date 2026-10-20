// 一次性验收脚本（T34 浏览器实证的服务端等价验证，用后即用，不入正式运维集）：
// 为指定邮箱现场签发会话 cookie，请求开发服务器 dashboard 与画像接口，验证老账号数据回迁可见。
// 用法：node --env-file=.env scripts/dev-verify-account.ts <email> [baseUrl]
import { createHmac } from "node:crypto";

import { prisma } from "../server/lib/prisma.ts";

const email = process.argv[2]?.trim();
const baseUrl = (process.argv[3] ?? "http://localhost:3000").replace(/\/+$/, "");
if (!email) {
  console.error("用法：node --env-file=.env scripts/dev-verify-account.ts <email> [baseUrl]");
  process.exit(1);
}
const secret = process.env.AUTH_SECRET?.trim();
if (!secret) {
  console.error("缺少环境变量 AUTH_SECRET");
  process.exit(1);
}

const user = await prisma.user.findUnique({ where: { email } });
await prisma.$disconnect();
if (!user) {
  console.error(`用户不存在：${email}`);
  process.exit(1);
}

const body = Buffer.from(
  JSON.stringify({ sub: user.id, email: user.email, exp: Date.now() + 3600_000 }),
).toString("base64url");
const sig = createHmac("sha256", secret).update(body).digest("base64url");
const cookie = `st_session=${body}.${sig}`;

async function check(path: string, label: string): Promise<void> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  const json = (await res.json()) as { success: boolean; data?: unknown; error?: { code: string } };
  if (!res.ok || !json.success) {
    console.log(`${label}: 失败 HTTP ${res.status} ${json.error?.code ?? ""}`);
    return;
  }
  const data = json.data as Record<string, unknown>;
  console.log(`${label}: 成功——字段 ${Object.keys(data).join("/")}`);
  console.log(`  摘要: ${JSON.stringify(data).slice(0, 220)}`);
}

await check("/api/dashboard", "仪表盘");
await check("/api/profile/ability", "能力画像");
