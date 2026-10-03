import type { PrismaClient, User } from "@prisma/client";

/**
 * 开发态身份解析（T03 魔法链接登录就绪前的占位实现）。
 *
 * 【T03 接入点】T03 完成登录后：
 * 1. 用真实的会话解析（cookie / token → user）替换本模块；
 * 2. 删除 DEV_USER_HEADER 透传与默认开发用户逻辑；
 * 3. 生产环境当前一律返回 null（未登录），调用方按 401 处理，保证安全默认。
 */

/** 开发态透传用户标识的请求头（值按用户邮箱解释，仅非生产环境生效） */
export const DEV_USER_HEADER = "x-dev-user-id";

/** 未带 header 时的默认开发用户邮箱 */
export const DEFAULT_DEV_EMAIL = "dev@skilltraining.local";

/** 从请求解析用户邮箱；生产环境未接入 T03 前返回 null */
export function resolveRequestEmail(request: Request): string | null {
  if (process.env.NODE_ENV === "production") return null;
  const fromHeader = request.headers.get(DEV_USER_HEADER)?.trim();
  return fromHeader || DEFAULT_DEV_EMAIL;
}

/** 确保请求对应的数据库用户存在（开发态按需创建占位用户），未登录返回 null */
export async function ensureRequestUser(
  db: PrismaClient,
  request: Request,
): Promise<User | null> {
  const email = resolveRequestEmail(request);
  if (!email) return null;
  return db.user.upsert({
    where: { email },
    create: { email },
    update: {},
  });
}
