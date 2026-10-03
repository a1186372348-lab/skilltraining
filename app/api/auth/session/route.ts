import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { getSessionSecret } from "@/server/modules/auth";
import { SESSION_COOKIE_NAME } from "@/server/modules/auth/cookies";
import { checkUnifiedAuthLimit, extractClientIp } from "@/server/modules/auth/guards";
import { fail, ok } from "@/server/modules/auth/response";
import { verifySessionToken } from "@/server/modules/auth/session";

/**
 * GET /api/auth/session
 * 读取当前会话：cookie 验签通过返回用户，否则 401（不区分无 cookie / 篡改 / 过期）。
 */
export async function GET(req: NextRequest) {
  const ip = extractClientIp(req.headers);
  if (!checkUnifiedAuthLimit(ip).allowed) {
    return NextResponse.json(fail("rate_limited", "请求过于频繁，请稍后再试"), { status: 429 });
  }

  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? verifySessionToken(token, getSessionSecret()) : null;
  if (!session) {
    return NextResponse.json(fail("unauthorized", "未登录或会话已过期"), { status: 401 });
  }

  return NextResponse.json(
    ok({
      user: { id: session.sub, email: session.email },
      expiresAt: new Date(session.expiresAt).toISOString(),
    }),
  );
}
