import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { getAuthService, getSessionSecret } from "@/server/modules/auth";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/server/modules/auth/cookies";
import { checkUnifiedAuthLimit, extractClientIp } from "@/server/modules/auth/guards";
import { verifyTokenQuerySchema } from "@/server/modules/auth/schemas";
import { createSessionToken } from "@/server/modules/auth/session";

/**
 * GET /api/auth/verify?token=...
 * 邮件中的登录链接：核销成功 → 种 httpOnly 会话 cookie 并跳转首页；
 * 任何失败（错 token / 过期 / 已使用 / 缺参数）→ 统一跳回登录页提示链接失效，
 * 不区分失败原因，不泄露 token 状态细节。
 */
export async function GET(req: NextRequest) {
  const ip = extractClientIp(req.headers);
  const loginUrl = new URL("/login", req.url);

  if (!checkUnifiedAuthLimit(ip).allowed) {
    loginUrl.searchParams.set("error", "rate_limited");
    return NextResponse.redirect(loginUrl);
  }

  const parsed = verifyTokenQuerySchema.safeParse(req.nextUrl.searchParams.get("token") ?? "");
  if (!parsed.success) {
    loginUrl.searchParams.set("error", "invalid_link");
    return NextResponse.redirect(loginUrl);
  }

  const result = await getAuthService().verifyMagicLink(parsed.data);
  if (!result.ok) {
    loginUrl.searchParams.set("error", "invalid_link");
    return NextResponse.redirect(loginUrl);
  }

  const sessionToken = createSessionToken(
    { sub: result.user.id, email: result.user.email },
    getSessionSecret(),
  );
  const res = NextResponse.redirect(new URL("/", req.url));
  res.cookies.set(SESSION_COOKIE_NAME, sessionToken, sessionCookieOptions());
  return res;
}
