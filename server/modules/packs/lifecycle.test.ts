import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserTransaction } from "@/server/lib/user-transaction";
import * as repository from "./repository";
import { createPackInTransaction, loadLockedPack, reconcileLockedPack } from "./lifecycle";
import type { PackRecord } from "./repository";

vi.mock("./eligibility", () => ({ assertPackEligible: vi.fn(), assertPackVisible: vi.fn() }));
vi.mock("./selection", () => ({ selectPackQuestions: vi.fn(() => []) }));
vi.mock("./repository", async (original) => ({
  ...await original<typeof import("./repository")>(),
  findActivePackId: vi.fn(), candidates: vi.fn(), insertPack: vi.fn(), lockPack: vi.fn(), readPack: vi.fn(),
}));

const id = "123e4567-e89b-42d3-a456-426614174000";
const context = { userId: id, tx: { trainingPack: { update: vi.fn() } } } as unknown as UserTransaction;

function databaseError(code: string, target: string | string[]) {
  return new Prisma.PrismaClientKnownRequestError("synthetic", { code, clientVersion: "test", meta: { target } });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(repository.findActivePackId).mockResolvedValue(null);
  vi.mocked(repository.candidates).mockResolvedValue({ questions: [], practiced: new Set() });
});

describe("包事务的异常处理", () => {
  it("只将活动包唯一约束冲突映射为已有包，不隐藏其他数据库错误", async () => {
    for (const target of [["user_id"], "training_packs_one_active_per_user_idx"]) {
      vi.mocked(repository.insertPack).mockRejectedValueOnce(databaseError("P2002", target));
      await expect(createPackInTransaction(context, "问题定义")).rejects.toMatchObject({ code: "ACTIVE_PACK_EXISTS", httpStatus: 409 });
    }
    for (const error of [databaseError("P2002", ["question_id"]), databaseError("P2003", ["user_id"]), new Error("database unavailable")]) {
      vi.mocked(repository.insertPack).mockRejectedValueOnce(error);
      await expect(createPackInTransaction(context, "问题定义")).rejects.toBe(error);
    }
  });

  it("非法 ID、非本人及持锁后找不到记录均只返回不存在", async () => {
    await expect(loadLockedPack(context, "invalid")).rejects.toMatchObject({ code: "PACK_NOT_FOUND" });
    vi.mocked(repository.lockPack).mockResolvedValueOnce(false);
    await expect(loadLockedPack(context, id)).rejects.toMatchObject({ code: "PACK_NOT_FOUND" });
    vi.mocked(repository.lockPack).mockResolvedValueOnce(true);
    vi.mocked(repository.readPack).mockResolvedValueOnce(null);
    await expect(loadLockedPack(context, id)).rejects.toMatchObject({ code: "PACK_NOT_FOUND" });
  });

  it("推进后无法回读时报告异常，不能伪造包结果", async () => {
    const time = new Date("2026-11-03T00:00:00Z");
    const pack = { id, status: "active", dimension: "问题定义", items: Array.from({ length: 5 }, (_, orderIndex) => ({
      orderIndex, unlockedAt: time, startedAt: time,
      session: { id, state: "scored", finalSubmittedAt: time, scoredAt: time, scores: [{ dimension: "问题定义", effectiveScore: 70 }] },
    })) } as unknown as PackRecord;
    vi.mocked(repository.readPack).mockResolvedValueOnce(null);
    await expect(reconcileLockedPack(context, pack)).rejects.toMatchObject({ code: "PACK_NOT_FOUND" });
  });
});
