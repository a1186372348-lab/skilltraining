import { createHash, randomBytes } from "node:crypto";

/**
 * 魔法链接一次性 token（FR-11 / D17）：
 * 明文 token 仅出现在邮件链接中，服务端只存 sha256 哈希，15 分钟过期。
 */

/** token 有效期：15 分钟（Prd.md 3.5，固定值） */
export const MAGIC_LINK_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface GeneratedMagicLinkToken {
  /** 明文 token（base64url，43 字符），仅用于拼接登录链接，绝不落库 */
  token: string;
  /** 服务端存储的 sha256 哈希（hex） */
  tokenHash: string;
  /** 过期时间 = 签发时间 + 15 分钟 */
  expiresAt: Date;
}

/** 生成一次性魔法链接 token；now 可注入以便测试 */
export function generateMagicLinkToken(now: Date = new Date()): GeneratedMagicLinkToken {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashMagicLinkToken(token),
    expiresAt: new Date(now.getTime() + MAGIC_LINK_TOKEN_TTL_MS),
  };
}

/** 计算明文 token 的存储哈希（sha256 hex） */
export function hashMagicLinkToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
