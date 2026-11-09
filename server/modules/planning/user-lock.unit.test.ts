import type { PrismaClient, TrainingPlan } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { getOrCreateCurrentPlan, getPlanProgress, setCurrentPlanStatus } from "./service";

const userId = "6729c899-63d9-4a0c-95c6-1d0d842fc8c8";
const week = new Date("2026-10-19T00:00:00Z");

describe("计划变更与包会话共享用户锁", () => {
  it("拒绝计划先获取用户锁，再在事务内重新读取和更新计划", async () => {
    const order: string[] = [];
    const plan = { id: "p1", userId, status: "active", weekStartDate: week };
    const tx = {
      $queryRaw: vi.fn(async () => { order.push("user-lock"); return [{ id: userId }]; }),
      trainingPlan: {
        findUnique: vi.fn(async () => { order.push("read-plan"); return plan; }),
        updateMany: vi.fn(async () => { order.push("update-plan"); return { count: 1 }; }),
        findFirstOrThrow: vi.fn(async () => ({ ...plan, status: "rejected" })),
      },
    };
    const db = { $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)) } as unknown as PrismaClient;
    const result = await setCurrentPlanStatus(db, userId, "rejected", { now: new Date("2026-10-20T12:00:00Z") });
    expect(result.status).toBe("rejected");
    expect(order).toEqual(["user-lock", "read-plan", "update-plan"]);
  });

  it("首次创建计划也在用户锁内复查当周，避免与包题创建竞态", async () => {
    const order: string[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => { order.push("user-lock"); return [{ id: userId }]; }),
      trainingPlan: {
        findUnique: vi.fn(async () => { order.push("read-plan"); return null; }),
        create: vi.fn(async ({ data }: { data: unknown }) => { order.push("create-plan"); return data; }),
      },
    };
    const db = { $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)) } as unknown as PrismaClient;
    await getOrCreateCurrentPlan(db, userId, {
      now: new Date("2026-10-20T12:00:00Z"),
      getProfileView: async () => [{ dimension: "问题定义", observed: true, currentScore: 60, observationCount: 1, hintDependency: null, hintDependencyBand: null, trend: null, updatedAt: null }],
    });
    expect(order).toEqual(["user-lock", "read-plan", "create-plan"]);
  });

  it("进度在用户锁内重读本人计划，调用方旧对象不会覆盖已封存口径", async () => {
    const order: string[] = [];
    const stale = { id: "p1", userId, weekStartDate: week, reviewSnapshot: null } as TrainingPlan;
    const snapshot = {
      schemaVersion: 1, generatedAt: "2026-10-25T09:00:00.000Z", scoredCount: 2,
      completedDays: 1, completedDates: ["2026-10-23"], startScore: 60, latestScore: 65, scoreChange: 5,
    };
    const findMany = vi.fn();
    const tx = {
      $queryRaw: vi.fn(async () => { order.push("user-lock"); return [{ id: userId }]; }),
      trainingPlan: { findFirst: vi.fn(async () => { order.push("read-plan"); return { ...stale, reviewSnapshot: snapshot }; }) },
      trainingSession: { findMany },
    };
    const db = {
      $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
      trainingSession: { findMany: vi.fn(async () => [{ scoredAt: new Date("2026-10-25T10:00:00Z") }]) },
    } as unknown as PrismaClient;
    const progress = await getPlanProgress(db, userId, stale);
    expect(progress).toEqual({ scoredCount: 2, completedDays: 1, completedDates: ["2026-10-23"] });
    expect(tx.trainingPlan.findFirst).toHaveBeenCalledWith({ where: { id: "p1", userId } });
    expect(order).toEqual(["user-lock", "read-plan"]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("未封存计划在同一事务内重读后聚合，其他用户的计划按不存在处理", async () => {
    const order: string[] = [];
    const plan = { id: "p1", userId, weekStartDate: week, reviewSnapshot: null } as TrainingPlan;
    const findFirst = vi.fn(async () => { order.push("read-plan"); return plan as TrainingPlan | null; });
    const tx = {
      $queryRaw: vi.fn(async () => { order.push("user-lock"); return [{ id: userId }]; }),
      trainingPlan: { findFirst },
      trainingSession: { findMany: vi.fn(async () => { order.push("aggregate"); return [{ scoredAt: new Date("2026-10-20T12:00:00Z") }]; }) },
    };
    const transaction = vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx));
    const db = { $transaction: transaction } as unknown as PrismaClient;
    expect(await getPlanProgress(db, userId, plan)).toEqual({ scoredCount: 1, completedDays: 1, completedDates: ["2026-10-20"] });
    expect(order).toEqual(["user-lock", "read-plan", "aggregate"]);
    expect(transaction).toHaveBeenCalledTimes(1);
    findFirst.mockResolvedValueOnce(null);
    await expect(getPlanProgress(db, userId, plan)).rejects.toMatchObject({ code: "PLAN_NOT_FOUND", httpStatus: 404 });
  });
});
