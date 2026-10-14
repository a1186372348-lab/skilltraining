import { getSessionSecret } from "@/server/modules/auth";
import { SESSION_COOKIE_NAME } from "@/server/modules/auth/cookies";
import { createSessionToken } from "@/server/modules/auth/session";

/**
 * 路由集成测试的共享会话构造（T34）：
 * 业务 API 已切换为真实会话解析，测试必须先 prisma.user.create 创建用户，
 * 再用本 helper 签发与登录链路一致的会话 cookie 放进请求 headers.cookie。
 * 密钥与路由同源（getSessionSecret 每次读环境变量），保证验签一致。
 */

/** 为指定用户签发会话 cookie 头值（st_session=<HMAC 签名令牌>） */
export function sessionCookieHeader(user: { id: string; email: string }): string {
  const token = createSessionToken(
    { sub: user.id, email: user.email },
    getSessionSecret(),
  );
  return `${SESSION_COOKIE_NAME}=${token}`;
}
