/**
 * 进程内固定窗口限流器（PRD 3.5：认证端点统一限流；登录邮件发送接口单独限流）。
 * V1 单实例部署，内存实现即可；时钟可注入以便测试。
 */

export interface RateLimitResult {
  allowed: boolean;
  /** 剩余额度（拒绝时为 0） */
  remaining: number;
  /** 拒绝时建议的重试等待秒数；放行时为 0 */
  retryAfterSeconds: number;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, WindowEntry>();

  constructor(options: { windowMs: number; max: number; now?: () => number }) {
    this.windowMs = options.windowMs;
    this.max = options.max;
    this.now = options.now ?? Date.now;
  }

  /** 检查并消耗一次额度 */
  check(key: string): RateLimitResult {
    const nowMs = this.now();
    let entry = this.entries.get(key);
    if (!entry || nowMs >= entry.resetAt) {
      entry = { count: 0, resetAt: nowMs + this.windowMs };
      this.entries.set(key, entry);
    }
    this.pruneIfNeeded(nowMs);

    if (entry.count >= this.max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000)),
      };
    }
    entry.count += 1;
    return { allowed: true, remaining: this.max - entry.count, retryAfterSeconds: 0 };
  }

  /** 清空全部计数（测试与运维用） */
  reset(): void {
    this.entries.clear();
  }

  /** 惰性清理过期窗口，避免长期运行内存膨胀 */
  private pruneIfNeeded(nowMs: number): void {
    if (this.entries.size < 10_000) return;
    for (const [key, entry] of this.entries) {
      if (nowMs >= entry.resetAt) this.entries.delete(key);
    }
  }
}
