import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createSessionToken,
  verifySessionToken,
  SESSION_TTL_MS,
} from "./session";

// 测试密钥每次运行随机生成：签验在同一进程内完成，避免硬编码凭据触发安全扫描
const SECRET = randomBytes(16).toString("hex");
const NOW = new Date("2026-10-03T02:00:00.000Z").getTime();
const PAYLOAD = { sub: "user-uuid-1", email: "pm@example.com" };

// 会话令牌：HMAC-SHA256 签名的无状态会话（schema 无会话表，cookie 承载）
describe("会话令牌", () => {
  it("签发后可验签通过并还原载荷", () => {
    const token = createSessionToken(PAYLOAD, SECRET, NOW);
    const result = verifySessionToken(token, SECRET, NOW);
    expect(result).toEqual({
      sub: PAYLOAD.sub,
      email: PAYLOAD.email,
      expiresAt: NOW + SESSION_TTL_MS,
    });
  });

  it("会话有效期为 7 天", () => {
    expect(SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("篡改载荷后验签失败", () => {
    const token = createSessionToken(PAYLOAD, SECRET, NOW);
    const [payloadB64, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "attacker", email: "a@b.c", exp: NOW + SESSION_TTL_MS }),
    ).toString("base64url");
    expect(verifySessionToken(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
    expect(payloadB64).not.toBe(forged);
  });

  it("篡改签名后验签失败", () => {
    const token = createSessionToken(PAYLOAD, SECRET, NOW);
    const [payloadB64] = token.split(".");
    const badSig = Buffer.from("forged-signature-bytes-0123456789ab").toString("base64url");
    expect(verifySessionToken(`${payloadB64}.${badSig}`, SECRET, NOW)).toBeNull();
  });

  it("密钥不匹配验签失败", () => {
    const token = createSessionToken(PAYLOAD, SECRET, NOW);
    expect(verifySessionToken(token, "other-secret", NOW)).toBeNull();
  });

  it("过期后会话失效", () => {
    const token = createSessionToken(PAYLOAD, SECRET, NOW);
    expect(verifySessionToken(token, SECRET, NOW + SESSION_TTL_MS)).toBeNull();
    expect(verifySessionToken(token, SECRET, NOW + SESSION_TTL_MS + 1)).toBeNull();
    // 过期前最后一毫秒仍有效
    expect(verifySessionToken(token, SECRET, NOW + SESSION_TTL_MS - 1)).not.toBeNull();
  });

  it("畸形 token 一律返回 null（不抛异常）", () => {
    expect(verifySessionToken("", SECRET, NOW)).toBeNull();
    expect(verifySessionToken("no-dot-here", SECRET, NOW)).toBeNull();
    expect(verifySessionToken("a.b.c", SECRET, NOW)).toBeNull();
    expect(verifySessionToken("!!!.???", SECRET, NOW)).toBeNull();
  });
});
