import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserTransaction } from "./user-transaction";

const db = new PrismaClient();
const ids: string[] = [];

async function user() {
  const row = await db.user.create({ data: { email: `t30-lock-${randomUUID()}@example.com` } });
  ids.push(row.id);
  return row;
}

beforeAll(async () => {
  const [row] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (row.name !== "skilltraining_test") throw new Error("测试数据库身份不匹配");
});
afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

describe("withUserTransaction", () => {
  it("先锁本人再交给回调；出错时整个事务回滚", async () => {
    const account = await user();
    await expect(withUserTransaction(db, account.id, async ({ tx, userId }) => {
      expect(userId).toBe(account.id);
      await tx.user.update({ where: { id: userId }, data: { email: `rollback-${randomUUID()}@example.com` } });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect((await db.user.findUniqueOrThrow({ where: { id: account.id } })).email).toBe(account.email);
  });

  it("不存在的用户不可进入事务回调", async () => {
    let entered = false;
    await expect(withUserTransaction(db, randomUUID(), async () => { entered = true; })).rejects.toThrow();
    expect(entered).toBe(false);
  });

  it("同一用户的并发事务串行，不同用户互不阻塞", async () => {
    const first = await user();
    const second = await user();
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = new Promise<void>(resolve => { locked = resolve; });
    const order: string[] = [];
    const a = withUserTransaction(db, first.id, async () => { order.push("a"); locked(); await gate; });
    await held;
    const b = withUserTransaction(db, first.id, async () => { order.push("b"); });
    try {
      await withUserTransaction(db, second.id, async () => { order.push("other"); });
      expect(order).toEqual(["a", "other"]);
    } finally { release(); }
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "other", "b"]);
  });
});
