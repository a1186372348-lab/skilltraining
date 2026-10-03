import { describe, expect, it } from "vitest";

import { FixedWindowRateLimiter } from "./rate-limiter";

// 固定窗口限流器：认证端点统一限流 + 发送接口独立限流（PRD 3.5）
describe("固定窗口限流器", () => {
  it("窗口内未超限放行，计数递减", () => {
    const now = 1_000_000;
    const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, max: 3, now: () => now });

    expect(limiter.check("ip-1")).toEqual({ allowed: true, remaining: 2, retryAfterSeconds: 0 });
    expect(limiter.check("ip-1")).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
    expect(limiter.check("ip-1")).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0 });
  });

  it("超过上限拒绝并给出重试秒数", () => {
    let now = 1_000_000;
    const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, max: 2, now: () => now });

    limiter.check("ip-1");
    limiter.check("ip-1");
    now += 10_000;
    const result = limiter.check("ip-1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("窗口结束后计数重置", () => {
    let now = 1_000_000;
    const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, max: 1, now: () => now });

    expect(limiter.check("ip-1").allowed).toBe(true);
    expect(limiter.check("ip-1").allowed).toBe(false);
    now += 61_000;
    expect(limiter.check("ip-1").allowed).toBe(true);
  });

  it("不同 key 独立计数", () => {
    const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, max: 1, now: () => 0 });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(false);
  });

  it("reset 清空全部计数（测试与运维用）", () => {
    const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, max: 1, now: () => 0 });
    limiter.check("a");
    limiter.reset();
    expect(limiter.check("a").allowed).toBe(true);
  });
});
