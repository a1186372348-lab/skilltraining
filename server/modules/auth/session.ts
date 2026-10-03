import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 无状态会话令牌（数据模型无会话表，会话由 httpOnly cookie 承载）：
 * 结构为 base64url(payloadJson) + "." + base64url(HMAC-SHA256(secret, payload))。
 * 验签使用常量时间比较，防止时序侧信道。
 */

/** 会话有效期：7 天 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionPayload {
  /** users.id */
  sub: string;
  /** 登录邮箱（展示用） */
  email: string;
}

export interface VerifiedSession extends SessionPayload {
  /** 会话过期时间（epoch ms） */
  expiresAt: number;
}

/** 签发会话令牌；nowMs 可注入以便测试 */
export function createSessionToken(
  payload: SessionPayload,
  secret: string,
  nowMs: number = Date.now(),
): string {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: nowMs + SESSION_TTL_MS }),
  ).toString("base64url");
  const sig = sign(body, secret);
  return `${body}.${sig}`;
}

/** 验签并校验有效期；任何异常（篡改/过期/畸形）一律返回 null，视为未登录 */
export function verifySessionToken(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): VerifiedSession | null {
  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0 || dotIndex !== token.lastIndexOf(".")) return null;

  const body = token.slice(0, dotIndex);
  const sig = token.slice(dotIndex + 1);
  if (!safeEqual(sig, sign(body, secret))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isSessionClaims(parsed)) return null;
  if (parsed.exp <= nowMs) return null;

  return { sub: parsed.sub, email: parsed.email, expiresAt: parsed.exp };
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** 常量时间比较；长度不同直接不等 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

interface SessionClaims {
  sub: string;
  email: string;
  exp: number;
}

function isSessionClaims(value: unknown): value is SessionClaims {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.sub === "string" && typeof v.email === "string" && typeof v.exp === "number";
}
