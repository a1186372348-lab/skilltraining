import { describe, expect, it, vi } from "vitest";

import { FixedWindowRateLimiter } from "./rate-limiter";
import type { AuthRepository, IdentityWithUser, StoredMagicLinkToken } from "./repository";
import { MAGIC_LINK_PROVIDER } from "./repository";
import { AuthService } from "./service";
import { hashMagicLinkToken } from "./token";
import type { Mailer } from "./mailer";

/** 内存版仓储：与 PrismaAuthRepository 同契约，供单元测试 */
class InMemoryAuthRepository implements AuthRepository {
  users: IdentityWithUser[] = [];
  tokens: StoredMagicLinkToken[] = [];
  private seq = 0;

  async findIdentityByEmail(email: string): Promise<IdentityWithUser | null> {
    return (
      this.users.find(
        (u) => u.identity.provider === MAGIC_LINK_PROVIDER && u.identity.providerUid === email,
      ) ?? null
    );
  }

  async createUserWithIdentity(email: string): Promise<IdentityWithUser> {
    this.seq += 1;
    const created: IdentityWithUser = {
      user: { id: `user-${this.seq}`, email },
      identity: { id: `identity-${this.seq}`, provider: MAGIC_LINK_PROVIDER, providerUid: email },
    };
    this.users.push(created);
    return created;
  }

  async createMagicLinkToken(input: {
    identityId: string;
    tokenHash: string;
    expiresAt: Date;
    createdIp?: string | null;
  }): Promise<void> {
    const owner = this.users.find((u) => u.identity.id === input.identityId);
    if (!owner) throw new Error("identity 不存在");
    this.tokens.push({
      id: `token-${this.tokens.length + 1}`,
      identityId: input.identityId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      usedAt: null,
      user: owner.user,
    });
  }

  async findTokenByHash(tokenHash: string): Promise<StoredMagicLinkToken | null> {
    return this.tokens.find((t) => t.tokenHash === tokenHash) ?? null;
  }

  async consumeMagicLinkToken(id: string, usedAt: Date): Promise<boolean> {
    const token = this.tokens.find((t) => t.id === id);
    if (!token || token.usedAt) return false;
    token.usedAt = usedAt;
    return true;
  }
}

class FakeMailer implements Mailer {
  sent: { to: string; link: string }[] = [];
  failWith: Error | null = null;

  async sendMagicLink(to: string, link: string): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push({ to, link });
  }
}

const BASE_URL = "http://localhost:3000";
const NOW = new Date("2026-10-03T02:00:00.000Z");

function setup(options: { now?: Date } = {}) {
  const repo = new InMemoryAuthRepository();
  const mailer = new FakeMailer();
  let now = options.now ?? NOW;
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const service = new AuthService({
    repo,
    mailer,
    baseUrl: BASE_URL,
    now: () => now,
    sendEmailLimiter: new FixedWindowRateLimiter({ windowMs: 60 * 60 * 1000, max: 5, now: () => now.getTime() }),
    logger,
  });
  return {
    repo,
    mailer,
    logger,
    service,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

/** 从邮件链接中提取明文 token */
function extractToken(link: string): string {
  const url = new URL(link);
  const token = url.searchParams.get("token");
  if (!token) throw new Error("链接缺少 token");
  return token;
}

describe("AuthService.requestMagicLink（发送魔法链接）", () => {
  it("新邮箱：创建 users + auth_identities（provider=email_magic_link）并投递链接", async () => {
    const { repo, mailer, service } = setup();

    const result = await service.requestMagicLink({ email: "  PM@Example.com ", createdIp: "1.2.3.4" });

    expect(result).toEqual({ ok: true });
    // 邮箱归一化（去空格 + 小写）
    expect(repo.users).toHaveLength(1);
    expect(repo.users[0].user.email).toBe("pm@example.com");
    expect(repo.users[0].identity.provider).toBe(MAGIC_LINK_PROVIDER);
    expect(repo.users[0].identity.providerUid).toBe("pm@example.com");
    // 链接指向核销端点且携带明文 token
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe("pm@example.com");
    expect(mailer.sent[0].link).toContain(`${BASE_URL}/api/auth/verify?token=`);
  });

  it("服务端只存 token 哈希，不存明文", async () => {
    const { repo, mailer, service } = setup();

    await service.requestMagicLink({ email: "pm@example.com" });

    const raw = extractToken(mailer.sent[0].link);
    expect(repo.tokens).toHaveLength(1);
    expect(repo.tokens[0].tokenHash).toBe(hashMagicLinkToken(raw));
    expect(repo.tokens[0].tokenHash).not.toBe(raw);
    // 15 分钟过期
    expect(repo.tokens[0].expiresAt.getTime() - NOW.getTime()).toBe(15 * 60 * 1000);
  });

  it("已注册邮箱：复用已有身份，不重复建用户", async () => {
    const { repo, service } = setup();

    await service.requestMagicLink({ email: "pm@example.com" });
    await service.requestMagicLink({ email: "pm@example.com" });

    expect(repo.users).toHaveLength(1);
    expect(repo.tokens).toHaveLength(2);
  });

  it("新邮箱与已注册邮箱的响应完全一致（不泄露注册状态）", async () => {
    const { service } = setup();
    const first = await service.requestMagicLink({ email: "new@example.com" });
    const second = await service.requestMagicLink({ email: "new@example.com" });
    expect(second).toEqual(first);
  });

  it("同一邮箱超出发送频率上限：拒绝且不再发信", async () => {
    const { mailer, service } = setup();

    for (let i = 0; i < 5; i += 1) {
      await service.requestMagicLink({ email: "pm@example.com" });
    }
    const limited = await service.requestMagicLink({ email: "pm@example.com" });

    expect(limited).toEqual({ ok: false, code: "rate_limited" });
    expect(mailer.sent).toHaveLength(5);
  });

  it("邮件投递失败：记录日志但仍返回统一成功（不泄露内部细节）", async () => {
    const { mailer, logger, service } = setup();
    mailer.failWith = new Error("SMTP 连接失败");

    const result = await service.requestMagicLink({ email: "pm@example.com" });

    expect(result).toEqual({ ok: true });
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe("AuthService.verifyMagicLink（核销魔法链接）", () => {
  it("正确 token：核销成功并返回用户；token 立即标记已使用", async () => {
    const { repo, mailer, service } = setup();
    await service.requestMagicLink({ email: "pm@example.com" });
    const raw = extractToken(mailer.sent[0].link);

    const result = await service.verifyMagicLink(raw);

    expect(result).toEqual({ ok: true, user: { id: "user-1", email: "pm@example.com" } });
    expect(repo.tokens[0].usedAt).toEqual(NOW);
  });

  it("错误 token：统一返回 invalid_token", async () => {
    const { service } = setup();
    await service.requestMagicLink({ email: "pm@example.com" });

    const result = await service.verifyMagicLink("wrong-token-value");

    expect(result).toEqual({ ok: false, code: "invalid_token" });
  });

  it("过期 token：核销失败", async () => {
    const { mailer, service, advance } = setup();
    await service.requestMagicLink({ email: "pm@example.com" });
    const raw = extractToken(mailer.sent[0].link);
    advance(15 * 60 * 1000); // 恰好到过期时刻即失效

    const result = await service.verifyMagicLink(raw);

    expect(result).toEqual({ ok: false, code: "invalid_token" });
  });

  it("过期前最后一毫秒仍可核销", async () => {
    const { mailer, service, advance } = setup();
    await service.requestMagicLink({ email: "pm@example.com" });
    const raw = extractToken(mailer.sent[0].link);
    advance(15 * 60 * 1000 - 1);

    const result = await service.verifyMagicLink(raw);

    expect(result.ok).toBe(true);
  });

  it("重复使用同一 token：第二次核销失败（一次性使用）", async () => {
    const { mailer, service } = setup();
    await service.requestMagicLink({ email: "pm@example.com" });
    const raw = extractToken(mailer.sent[0].link);

    const first = await service.verifyMagicLink(raw);
    const second = await service.verifyMagicLink(raw);

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, code: "invalid_token" });
  });

  it("错 token / 过期 / 重用 的失败响应一致（不泄露 token 状态细节）", async () => {
    const { mailer, service, advance } = setup();
    await service.requestMagicLink({ email: "pm@example.com" });
    const raw = extractToken(mailer.sent[0].link);

    const wrong = await service.verifyMagicLink("wrong-token-value");
    advance(15 * 60 * 1000);
    const expired = await service.verifyMagicLink(raw);
    expect(wrong).toEqual(expired);
  });
});
