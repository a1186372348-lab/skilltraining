import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";

const lockedUser = Symbol("lockedUser");

/** 仅由 withUserTransaction 创建；回调结束后不可保留或复用。 */
export type UserTransaction = Readonly<{
  tx: Prisma.TransactionClient;
  userId: string;
  [lockedUser]: true;
}>;

export class UserTransactionError extends Error {
  readonly code = "USER_NOT_FOUND";

  constructor() {
    super("用户不存在");
    this.name = "UserTransactionError";
  }
}

/**
 * 持本人行锁运行短事务；后续按 user → pack → plan 的顺序加锁。
 * 回调不得等待模型、邮件或其他外部网络；不要嵌套调用本函数。
 */
export async function withUserTransaction<T>(
  db: PrismaClient,
  userId: string,
  callback: (context: UserTransaction) => Promise<T>,
): Promise<T> {
  const validUserId = z.string().uuid().parse(userId);
  return db.$transaction(async (tx) => {
    const users = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${validUserId}::uuid FOR UPDATE
    `;
    if (users.length !== 1) throw new UserTransactionError();
    const context: UserTransaction = Object.freeze({ tx, userId: validUserId, [lockedUser]: true as const });
    return callback(context);
  }, { maxWait: 10000, timeout: 20000 });
}
