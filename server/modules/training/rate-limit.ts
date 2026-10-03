import { FixedWindowRateLimiter } from "@/server/modules/auth/rate-limiter";

/**
 * AI 调用端点限流（Prd.md 3.5：追问、评分等 AI 调用端点启用速率限制；
 * R5：按用户调用量做预算护栏）。V1 单实例部署，进程内固定窗口即可。
 * 键为「端点:用户 id」，避免不同端点互相挤占额度。
 */
export const aiEndpointRateLimiter = new FixedWindowRateLimiter({
  windowMs: 60_000,
  max: 30, // 每用户每端点每分钟 30 次（追问/终答各触发至多 1 次 AI 调用，额度宽裕）
});
