import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MAGIC_LINK_TOKEN_TTL_MS,
  generateMagicLinkToken,
  hashMagicLinkToken,
} from "./token";

// token 生成与哈希：PRD 3.5 要求服务端仅存哈希、一次性使用、15 分钟过期
describe("魔法链接 token", () => {
  it("生成 base64url 明文 token（32 字节随机数，43 字符）", () => {
    const { token } = generateMagicLinkToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("两次生成的 token 不相同（随机性）", () => {
    const a = generateMagicLinkToken();
    const b = generateMagicLinkToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it("哈希为 sha256 hex（64 字符），且与明文不同", () => {
    const { token, tokenHash } = generateMagicLinkToken();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toBe(token);
  });

  it("hashMagicLinkToken 与 sha256 一致且确定", () => {
    const raw = "some-raw-token";
    const expected = createHash("sha256").update(raw).digest("hex");
    expect(hashMagicLinkToken(raw)).toBe(expected);
    expect(hashMagicLinkToken(raw)).toBe(hashMagicLinkToken(raw));
  });

  it("过期时间为签发后 15 分钟（FR-11）", () => {
    const now = new Date("2026-10-03T02:00:00.000Z");
    const { expiresAt } = generateMagicLinkToken(now);
    expect(MAGIC_LINK_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
    expect(expiresAt.getTime() - now.getTime()).toBe(MAGIC_LINK_TOKEN_TTL_MS);
  });
});
