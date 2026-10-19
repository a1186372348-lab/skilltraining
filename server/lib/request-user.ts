import type { PrismaClient, User } from "@prisma/client";

import { getSessionSecret } from "@/server/modules/auth";
import { SESSION_COOKIE_NAME } from "@/server/modules/auth/cookies";
import { verifySessionToken } from "@/server/modules/auth/session";

/**
 * 请求级会话解析（T34，替换原开发态占位身份模块）：
 * 读会话 cookie → 验签/校验有效期 → 按 sub 查 users → 返回 User；
 * 缺失/伪造/过期/用户不存在一律返回 null，调用方按 401 处理（安全默认）。
 */

/** 从请求解析当前登录用户；未登录或会话无效返回 null */
export async function getRequestUser(
  db: PrismaClient,
  request: Request,
): Promise<User | null> {
  const token = readSessionCookie(request.headers.get("cookie"));
  if (!token) return null;
  const session = verifySessionToken(token, getSessionSecret());
  if (!session) return null;
  return db.user.findUnique({ where: { id: session.sub } });
}

/** 从 Cookie 头中提取会话令牌；令牌为 base64url 结构，无需解码 */
function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}
