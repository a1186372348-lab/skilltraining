import { describe, expect, it, vi } from "vitest";
import type { UserTransaction } from "@/server/lib/user-transaction";
import { stageEligibility } from "./eligibility";

describe("阶段门禁异常", () => {
  it("数据库异常原样传播，不能误判成基线未完成", async () => {
    const failure = new Error("synthetic database error");
    const context = { userId: "test", tx: { trainingSession: { findFirst: vi.fn().mockRejectedValue(failure) } } } as unknown as UserTransaction;
    await expect(stageEligibility(context)).rejects.toBe(failure);
  });
});
