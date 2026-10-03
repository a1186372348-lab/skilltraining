import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db";

import { MAGIC_LINK_PROVIDER, PrismaAuthRepository } from "./repository";

// 集成测试：PrismaAuthRepository 直连本地 PostgreSQL（docker-compose，端口 5433）。
// 数据库不可达时整组跳过，避免 CI/无 Docker 环境误报。

async function isDbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

const dbReady = await isDbReachable();

describe.skipIf(!dbReady)("PrismaAuthRepository（真实数据库集成）", () => {
  const repo = new PrismaAuthRepository(prisma);
  const email = `t03-integration-${Date.now()}@example.com`;
  const tokenHash = "ab".repeat(32); // 64 位 hex 形态的假哈希
  let userId: string | null = null;

  afterAll(async () => {
    // 级联清理：删 users 即连带删除 auth_identities 与 magic_link_tokens
    if (userId) await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("users 与 auth_identities 分离写入，provider=email_magic_link", async () => {
    expect(await repo.findIdentityByEmail(email)).toBeNull();

    const created = await repo.createUserWithIdentity(email);
    userId = created.user.id;

    expect(created.user.email).toBe(email);
    expect(created.identity.provider).toBe(MAGIC_LINK_PROVIDER);
    expect(created.identity.providerUid).toBe(email);

    const found = await repo.findIdentityByEmail(email);
    expect(found?.user.id).toBe(userId);
  });

  it("并发/重复创建同一邮箱：撞唯一约束后回读已有身份，不重复建用户", async () => {
    const again = await repo.createUserWithIdentity(email);
    expect(again.user.id).toBe(userId);
  });

  it("token 写入与按哈希读取；原子核销防并发重用", async () => {
    const owner = await repo.findIdentityByEmail(email);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await repo.createMagicLinkToken({
      identityId: owner!.identity.id,
      tokenHash,
      expiresAt,
      createdIp: "127.0.0.1",
    });

    const token = await repo.findTokenByHash(tokenHash);
    expect(token).not.toBeNull();
    expect(token!.usedAt).toBeNull();
    expect(token!.expiresAt.getTime()).toBe(expiresAt.getTime());
    expect(token!.user.email).toBe(email);

    // 第一次核销成功；第二次（模拟并发/重用）失败
    expect(await repo.consumeMagicLinkToken(token!.id, new Date())).toBe(true);
    expect(await repo.consumeMagicLinkToken(token!.id, new Date())).toBe(false);

    const consumed = await repo.findTokenByHash(tokenHash);
    expect(consumed!.usedAt).not.toBeNull();
  });

  it("按哈希找不到 token 时返回 null", async () => {
    expect(await repo.findTokenByHash("ff".repeat(32))).toBeNull();
  });
});
