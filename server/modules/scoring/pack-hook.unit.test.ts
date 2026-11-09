import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { scoreSession } from "./service";
import { safelyAdvancePack } from "./pack-hook";

function scoredDb(sourceType: "pack" | "daily") {
  return {
    trainingSession: { findUnique: vi.fn(async () => ({
      id: "s1", userId: "u1", sourceType, sourceId: sourceType === "pack" ? "p1" : null,
      question: { abilityTags: ["问题定义"], rubric: { dimensions: { 问题定义: ["标准"] } } },
    })) },
    score: { findMany: vi.fn(async () => [{ dimension: "问题定义", rawScore: 80, hintCount: 0, coefficient: 1, effectiveScore: 80, diagnosisText: null, confidence: null }]) },
    sessionFeedback: { findUnique: vi.fn(async () => ({ topIssueText: "问题", nextFocusText: "建议" })) },
  } as unknown as PrismaClient;
}

describe("评分后的训练包恢复钩子", () => {
  it("已有评分的幂等短路也会尝试推进，失败不影响反馈且日志不泄露异常", async () => {
    const afterPackScored = vi.fn(async () => { throw new Error("private-secret"); });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await scoreSession(scoredDb("pack"), "s1", "u1", { afterPackScored } as never);
      expect(result.state).toBe("scored");
      expect(afterPackScored).toHaveBeenCalledWith(expect.anything(), "u1", "p1");
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private-secret");
    } finally { warning.mockRestore(); }
  });

  it("普通会话不触发包推进", async () => {
    const afterPackScored = vi.fn();
    await scoreSession(scoredDb("daily"), "s1", "u1", { afterPackScored } as never);
    expect(afterPackScored).not.toHaveBeenCalled();
  });

  it("包来源缺失时只记脱敏恢复事件，不猜测关联或影响评分", async () => {
    const hook = vi.fn();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await safelyAdvancePack({} as PrismaClient, "u1", { sourceType: "pack", sourceId: null }, hook);
      expect(hook).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("training.pack_reconcile_missing_source"));
    } finally { warning.mockRestore(); }
  });
});
