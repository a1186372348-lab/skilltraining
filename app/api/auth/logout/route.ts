import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/server/modules/auth/cookies";
import { checkUnifiedAuthLimit, extractClientIp } from "@/server/modules/auth/guards";
import { fail, ok } from "@/server/modules/auth/response";

/**
 * POST /api/auth/logout
 * 注销：立即使会话 cookie 过期（无状态会话，服务端无需删数据）。
 */
export async function POST(req: NextRequest) {
  const ip = extractClientIp(req.headers);
  if (!checkUnifiedAuthLimit(ip).allowed) {
    return NextResponse.json(fail("rate_limited", "请求过于频繁，请稍后再试"), { status: 429 });
  }

  const res = NextResponse.json(ok({ message: "已退出登录" }));
  res.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions(), maxAge: 0 });
  return res;
}
