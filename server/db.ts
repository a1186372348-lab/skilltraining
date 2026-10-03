import { PrismaClient } from "@prisma/client";

/**
 * PrismaClient 单例：开发环境挂到 globalThis，避免 Next 热重载产生多个连接池。
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
