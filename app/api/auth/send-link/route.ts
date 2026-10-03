import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { getAuthService } from "@/server/modules/auth";
import { checkSendLinkIpLimit, checkUnifiedAuthLimit, extractClientIp } from "@/server/modules/auth/guards";
import { fail, ok } from "@/server/modules/auth/response";
import { sendLinkRequestSchema } from "@/server/modules/auth/schemas";

/** 统一成功口径：无论邮箱是否已注册都返回同一段话（不泄露注册状态） */
const GENERIC_MESSAGE = "如果该邮箱可用于登录，我们已向它发送登录链接，请查收邮件（15 分钟内有效）。";

/**
 * POST /api/auth/send-link
 * 发送魔法链接。限流三道：统一认证额度（每 IP）→ 发送独立额度（每 IP）→ 按邮箱额度（service 内）。
 */
export async function POST(req: NextRequest) {
  const ip = extractClientIp(req.headers);

  if (!checkUnifiedAuthLimit(ip).allowed) {
    return NextResponse.json(fail("rate_limited", "请求过于频繁，请稍后再试"), { status: 429 });
  }
  if (!checkSendLinkIpLimit(ip).allowed) {
    return NextResponse.json(fail("rate_limited", "发送过于频繁，请稍后再试"), { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(fail("invalid_input", "请求体必须是 JSON"), { status: 400 });
  }
  const parsed = sendLinkRequestSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "入参不合法";
    return NextResponse.json(fail("invalid_input", message), { status: 400 });
  }

  const result = await getAuthService().requestMagicLink({
    email: parsed.data.email,
    createdIp: ip === "unknown" ? null : ip,
  });
  if (!result.ok) {
    return NextResponse.json(fail("rate_limited", "发送过于频繁，请稍后再试"), { status: 429 });
  }
  return NextResponse.json(ok({ message: GENERIC_MESSAGE }));
}
