import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ abandon: vi.fn(), context: vi.fn() }));
vi.mock("@/server/lib/user-transaction", () => ({
  withUserTransaction: async (db: unknown, userId: string, fn: (context: unknown) => unknown) => {
    const context = { tx: db, userId };
    mocks.context(context);
    return fn(context);
  },
}));
vi.mock("@/server/modules/packs", () => ({
  PackError: class PackError extends Error {
    constructor(readonly code: string, readonly httpStatus: number, message: string) { super(message); }
  },
  abandonPackInTransaction: mocks.abandon,
  getActivePackInTransaction: vi.fn(),
  openPackItemInTransaction: vi.fn(),
}));

import { abandonSession } from "./service";
import { PackError } from "@/server/modules/packs";

function fakeSession(finalSubmittedAt: Date | null = null) {
  let row = { id: "s1", userId: "u1", sourceType: "pack", sourceId: "p1", state: "followup", finalSubmittedAt, question: { kind: "daily" } };
  const db = { trainingSession: { findUnique: vi.fn(async () => ({ ...row })) } } as unknown as PrismaClient;
  return { db, row: () => row, terminate: () => { row = { ...row, state: "abandoned" }; } };
}

describe("终止包题必须确认并原子放弃整包", () => {
  beforeEach(() => { mocks.abandon.mockReset(); mocks.context.mockReset(); });

  it("未确认不得终止会话或整包", async () => {
    const fake = fakeSession();
    await expect(abandonSession(fake.db, "s1", "u1", { confirmAbandonPack: false } as never))
      .rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(mocks.abandon).not.toHaveBeenCalled();
    expect(fake.row().state).toBe("followup");
  });

  it("确认后将同一事务上下文交给包模块并返回真实终止态", async () => {
    const fake = fakeSession();
    mocks.abandon.mockImplementation(async () => { fake.terminate(); });
    await expect(abandonSession(fake.db, "s1", "u1", { confirmAbandonPack: true } as never)).resolves.toEqual({ state: "abandoned" });
    expect(mocks.abandon).toHaveBeenCalledWith(mocks.context.mock.calls[0][0], "p1", { confirmed: true });
  });

  it("已提交终答不得由单题终止入口放弃整包", async () => {
    const fake = fakeSession(new Date("2026-11-03T10:00:00Z"));
    await expect(abandonSession(fake.db, "s1", "u1", { confirmAbandonPack: true } as never))
      .rejects.toMatchObject({ code: "FINAL_ANSWER_ALREADY_SUBMITTED" });
    expect(mocks.abandon).not.toHaveBeenCalled();
  });

  it("包来源损坏或包服务未实际终止会话时，不伪报终止成功", async () => {
    const missingSource = fakeSession();
    vi.mocked(missingSource.db.trainingSession.findUnique).mockResolvedValueOnce({ ...missingSource.row(), sourceId: null } as never);
    await expect(abandonSession(missingSource.db, "s1", "u1", { confirmAbandonPack: true }))
      .rejects.toMatchObject({ code: "ITEM_INCONSISTENT" });
    const unchanged = fakeSession();
    mocks.abandon.mockResolvedValue(undefined);
    await expect(abandonSession(unchanged.db, "s1", "u1", { confirmAbandonPack: true }))
      .rejects.toMatchObject({ code: "ITEM_INCONSISTENT" });
  });

  it("包域冲突保留可识别状态，未知错误不被吞掉", async () => {
    const fake = fakeSession();
    mocks.abandon.mockRejectedValueOnce(new PackError("ITEM_LOCKED", 409, "锁定"));
    await expect(abandonSession(fake.db, "s1", "u1", { confirmAbandonPack: true }))
      .rejects.toMatchObject({ code: "ITEM_LOCKED", httpStatus: 409 });
    mocks.abandon.mockRejectedValueOnce(new Error("unexpected"));
    await expect(abandonSession(fake.db, "s1", "u1", { confirmAbandonPack: true })).rejects.toThrow("unexpected");
  });

  it("普通题终止条件失败后依据真实会话状态返回", async () => {
    const initial = { ...fakeSession().row(), sourceType: "daily", sourceId: null };
    for (const [fresh, expected] of [
      [{ ...initial, state: "abandoned" }, "abandoned"],
      [{ ...initial, state: "scored" }, "SESSION_ALREADY_SCORED"],
      [{ ...initial, finalSubmittedAt: new Date() }, "FINAL_ANSWER_ALREADY_SUBMITTED"],
      [initial, "INVALID_STATE"],
    ] as const) {
      const findUnique = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh);
      const db = { trainingSession: { findUnique, updateMany: vi.fn(async () => ({ count: 0 })) } } as unknown as PrismaClient;
      const result = abandonSession(db, "s1", "u1");
      if (expected === "abandoned") await expect(result).resolves.toEqual({ state: "abandoned" });
      else await expect(result).rejects.toMatchObject({ code: expected });
    }
  });
});
