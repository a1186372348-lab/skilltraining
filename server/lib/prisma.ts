import { PrismaClient } from "@prisma/client";

/**
 * PrismaClient 单例：避免 Next.js 开发态热更新时反复建立连接池。
 * 连接串来自环境变量 DATABASE_URL（见 .env，不入库硬编码）。
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
