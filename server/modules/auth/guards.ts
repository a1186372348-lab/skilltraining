import { FixedWindowRateLimiter, type RateLimitResult } from "./rate-limiter";

/**
 * 认证端点限流守卫（Prd.md 3.5）：
 * - 统一限流：所有 /api/auth/* 端点共享每 IP 额度，防暴力试探；
 * - 发送接口独立限流：/api/auth/send-link 另有每 IP 额度，防邮件轰炸
 *   （按邮箱的第三道限流在 AuthService 内部）。
 */

// 统一限流：每 IP 15 分钟 60 次
const unifiedAuthLimiter = new FixedWindowRateLimiter({ windowMs: 15 * 60 * 1000, max: 60 });
// 发送接口独立限流：每 IP 15 分钟 10 次
const sendLinkIpLimiter = new FixedWindowRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

export function checkUnifiedAuthLimit(ip: string): RateLimitResult {
  return unifiedAuthLimiter.check(`unified:${ip}`);
}

export function checkSendLinkIpLimit(ip: string): RateLimitResult {
  return sendLinkIpLimiter.check(`send:${ip}`);
}

/** 提取客户端 IP（反代场景取 X-Forwarded-For 首跳；缺失时为 unknown） */
export function extractClientIp(headers: Pick<Headers, "get">): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** 清空限流计数（仅测试使用） */
export function resetAuthRateLimitersForTests(): void {
  unifiedAuthLimiter.reset();
  sendLinkIpLimiter.reset();
}
