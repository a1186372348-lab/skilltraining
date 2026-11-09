import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { assertAbilityResultsVisible, BaselineRequiredError } from "./result-visibility";

describe("画像结果可见性", () => {
  it("无未完成基线会话时可读取，有未完成会话时拒绝", async () => {
    const findFirst = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "s" });
    const db = { trainingSession: { findFirst } } as unknown as PrismaClient;
    await expect(assertAbilityResultsVisible(db, "owner")).resolves.toBeUndefined();
    await expect(assertAbilityResultsVisible(db, "owner")).rejects.toBeInstanceOf(BaselineRequiredError);
    expect(findFirst.mock.calls[0][0].where.userId).toBe("owner");
  });

  it("查询异常不被误当成可以揭晓", async () => {
    const db = { trainingSession: { findFirst: vi.fn().mockRejectedValue(new Error("unavailable")) } } as unknown as PrismaClient;
    await expect(assertAbilityResultsVisible(db, "owner")).rejects.toThrow("unavailable");
  });
});
