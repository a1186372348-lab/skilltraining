import { describe, expect, it, vi } from "vitest";
import type { UserTransaction } from "@/server/lib/user-transaction";
import { assertPackVisible } from "./eligibility";

describe("包可见性守卫", () => {
  it("数据库故障原样抛出，不误判为基线未完成", async () => {
    const failure = new Error("synthetic database unavailable");
    const context = { userId: "test", tx: { trainingSession: { findFirst: vi.fn().mockRejectedValue(failure) } } } as unknown as UserTransaction;
    await expect(assertPackVisible(context)).rejects.toBe(failure);
  });
});
