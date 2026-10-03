import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

/**
 * 认证仓储：users / auth_identities / magic_link_tokens 的数据访问边界。
 * 业务逻辑只依赖 AuthRepository 接口（测试用内存实现，生产用 Prisma 实现）。
 */

/** V1 唯一登录方式（Prd.md D17；email_code / wechat 为 V2 预留） */
export const MAGIC_LINK_PROVIDER = "email_magic_link";

export interface IdentityWithUser {
  user: { id: string; email: string };
  identity: { id: string; provider: string; providerUid: string };
}

export interface StoredMagicLinkToken {
  id: string;
  identityId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  /** token 归属用户（核销后直接用于建会话） */
  user: { id: string; email: string };
}

export interface AuthRepository {
  /** 按 provider=email_magic_link + 邮箱查找登录身份（含用户） */
  findIdentityByEmail(email: string): Promise<IdentityWithUser | null>;
  /** 首次登录：同事务写入 users 与 auth_identities（D17 分离结构） */
  createUserWithIdentity(email: string): Promise<IdentityWithUser>;
  /** 写入一次性 token（仅存哈希） */
  createMagicLinkToken(input: {
    identityId: string;
    tokenHash: string;
    expiresAt: Date;
    createdIp?: string | null;
  }): Promise<void>;
  /** 按哈希查找 token（含归属用户） */
  findTokenByHash(tokenHash: string): Promise<StoredMagicLinkToken | null>;
  /** 原子核销：仅当未使用时置 usedAt；返回 false 表示已被使用（防并发重用） */
  consumeMagicLinkToken(id: string, usedAt: Date): Promise<boolean>;
}

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findIdentityByEmail(email: string): Promise<IdentityWithUser | null> {
    const identity = await this.prisma.authIdentity.findUnique({
      where: {
        provider_providerUid: { provider: MAGIC_LINK_PROVIDER, providerUid: email },
      },
      include: { user: true },
    });
    if (!identity) return null;
    return {
      user: { id: identity.user.id, email: identity.user.email },
      identity: { id: identity.id, provider: identity.provider, providerUid: identity.providerUid },
    };
  }

  async createUserWithIdentity(email: string): Promise<IdentityWithUser> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({ data: { email } });
        const identity = await tx.authIdentity.create({
          data: { userId: user.id, provider: MAGIC_LINK_PROVIDER, providerUid: email },
        });
        return {
          user: { id: user.id, email: user.email },
          identity: { id: identity.id, provider: identity.provider, providerUid: identity.providerUid },
        };
      });
    } catch (err) {
      // 并发请求同一邮箱撞唯一约束：回读已有身份即可（不重复建用户）
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const existing = await this.findIdentityByEmail(email);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async createMagicLinkToken(input: {
    identityId: string;
    tokenHash: string;
    expiresAt: Date;
    createdIp?: string | null;
  }): Promise<void> {
    await this.prisma.magicLinkToken.create({
      data: {
        identityId: input.identityId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        createdIp: input.createdIp ?? null,
      },
    });
  }

  async findTokenByHash(tokenHash: string): Promise<StoredMagicLinkToken | null> {
    const token = await this.prisma.magicLinkToken.findUnique({
      where: { tokenHash },
      include: { identity: { include: { user: true } } },
    });
    if (!token) return null;
    return {
      id: token.id,
      identityId: token.identityId,
      tokenHash: token.tokenHash,
      expiresAt: token.expiresAt,
      usedAt: token.usedAt,
      user: { id: token.identity.user.id, email: token.identity.user.email },
    };
  }

  async consumeMagicLinkToken(id: string, usedAt: Date): Promise<boolean> {
    const result = await this.prisma.magicLinkToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt },
    });
    return result.count === 1;
  }
}
