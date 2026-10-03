import { prisma } from "@/server/db";

import { getAuthConfig } from "./config";
import { createMailer } from "./mailer";
import { PrismaAuthRepository } from "./repository";
import { AuthService } from "./service";

/**
 * 认证模块组合根：生产环境由 Prisma 仓储 + 环境变量配置的投递器组装；
 * 测试通过 setAuthServiceForTests 注入内存实现。
 */

let singleton: AuthService | null = null;
let testOverride: AuthService | null = null;

export function getAuthService(): AuthService {
  if (testOverride) return testOverride;
  singleton ??= buildAuthService();
  return singleton;
}

function buildAuthService(): AuthService {
  const config = getAuthConfig();
  return new AuthService({
    repo: new PrismaAuthRepository(prisma),
    mailer: createMailer(config.smtp),
    baseUrl: config.baseUrl,
  });
}

/** 会话签名密钥（每次读取环境变量，便于测试注入） */
export function getSessionSecret(): string {
  return getAuthConfig().sessionSecret;
}

/** 仅测试使用：注入/清除 AuthService 替代实现 */
export function setAuthServiceForTests(service: AuthService | null): void {
  testOverride = service;
}
