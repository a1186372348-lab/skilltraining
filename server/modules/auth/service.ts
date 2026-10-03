import type { Mailer } from "./mailer";
import { FixedWindowRateLimiter } from "./rate-limiter";
import type { AuthRepository } from "./repository";
import { generateMagicLinkToken, hashMagicLinkToken } from "./token";

/**
 * 认证业务服务：发送魔法链接、核销建会话。
 * 安全约束（Prd.md 3.5 / T03 失败与回滚）：
 * - token 相关异常一律视为登录失败，对外统一 invalid_token，不区分原因；
 * - 发送响应对新/老邮箱完全一致，不泄露邮箱是否已注册；
 * - 发送接口按邮箱独立限流，防止邮件轰炸。
 */

export interface AuthServiceDeps {
  repo: AuthRepository;
  mailer: Mailer;
  /** 应用基础地址，用于拼接登录链接 */
  baseUrl: string;
  now?: () => Date;
  /** 发送接口按邮箱限流；默认 5 次/小时 */
  sendEmailLimiter?: FixedWindowRateLimiter;
  logger?: Pick<typeof console, "error" | "warn" | "info">;
}

export type RequestMagicLinkResult = { ok: true } | { ok: false; code: "rate_limited" };

export type VerifyMagicLinkResult =
  | { ok: true; user: { id: string; email: string } }
  | { ok: false; code: "invalid_token" };

const INVALID_TOKEN: VerifyMagicLinkResult = { ok: false, code: "invalid_token" };

export class AuthService {
  private readonly deps: Required<Omit<AuthServiceDeps, "sendEmailLimiter">> & {
    sendEmailLimiter: FixedWindowRateLimiter;
  };

  constructor(deps: AuthServiceDeps) {
    this.deps = {
      ...deps,
      now: deps.now ?? (() => new Date()),
      logger: deps.logger ?? console,
      sendEmailLimiter:
        deps.sendEmailLimiter ??
        new FixedWindowRateLimiter({ windowMs: 60 * 60 * 1000, max: 5 }),
    };
  }

  /** 发送魔法链接；响应刻意与注册状态无关 */
  async requestMagicLink(input: { email: string; createdIp?: string | null }): Promise<RequestMagicLinkResult> {
    const email = input.email.trim().toLowerCase();

    if (!this.deps.sendEmailLimiter.check(`email:${email}`).allowed) {
      return { ok: false, code: "rate_limited" };
    }

    // users / auth_identities 分离写入：首次登录一个事务建两表，老用户复用身份
    const existing = await this.deps.repo.findIdentityByEmail(email);
    const owner = existing ?? (await this.deps.repo.createUserWithIdentity(email));

    const { token, tokenHash, expiresAt } = generateMagicLinkToken(this.deps.now());
    await this.deps.repo.createMagicLinkToken({
      identityId: owner.identity.id,
      tokenHash,
      expiresAt,
      createdIp: input.createdIp ?? null,
    });

    const link = `${this.deps.baseUrl}/api/auth/verify?token=${encodeURIComponent(token)}`;
    try {
      await this.deps.mailer.sendMagicLink(email, link);
    } catch (err) {
      // 投递失败只记录服务端日志，对外仍统一成功（不泄露内部细节）
      this.deps.logger.error("[auth] 魔法链接投递失败", err);
    }
    return { ok: true };
  }

  /** 核销魔法链接：校验存在、未使用、未过期后原子核销并返回用户 */
  async verifyMagicLink(rawToken: string): Promise<VerifyMagicLinkResult> {
    const record = await this.deps.repo.findTokenByHash(hashMagicLinkToken(rawToken));
    if (!record) return INVALID_TOKEN;
    if (record.usedAt) return INVALID_TOKEN;
    if (record.expiresAt.getTime() <= this.deps.now().getTime()) return INVALID_TOKEN;

    const consumed = await this.deps.repo.consumeMagicLinkToken(record.id, this.deps.now());
    if (!consumed) return INVALID_TOKEN; // 并发核销竞争：先到先得

    return { ok: true, user: record.user };
  }
}
