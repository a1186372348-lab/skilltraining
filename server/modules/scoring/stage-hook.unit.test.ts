import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { scoreSession } from "./service";
import { safelyReconcileStages } from "./stage-hook";

function existingPackScore() {
  return {
    trainingSession: { findUnique: vi.fn(async () => ({
      id: "s1", userId: "u1", sourceType: "pack", sourceId: "p1", scoredDimensions: ["问题定义"],
      question: { abilityTags: ["问题定义"], rubric: { dimensions: { 问题定义: ["标准"] } } },
    })) },
    score: { findMany: vi.fn(async () => [{ dimension: "问题定义", rawScore: 80, hintCount: 0, coefficient: 1, effectiveScore: 80, diagnosisText: null, confidence: null }]) },
    sessionFeedback: { findUnique: vi.fn(async () => ({ topIssueText: "问题", nextFocusText: "建议" })) },
  } as unknown as PrismaClient;
}

describe("阶段评分后恢复", () => {
  it("未启用基线的正常跳过不记错误", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hook = vi.fn(async () => ({ status: "skipped" }));
      await safelyReconcileStages({} as PrismaClient, "u1", hook);
      expect(hook).toHaveBeenCalledOnce();
      expect(warning).not.toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });

  it("包与阶段恢复各自失败不影响另一方或已有评分，日志不泄露异常", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const fail of ["pack", "stage"] as const) {
        const afterPackScored = vi.fn(async () => { if (fail === "pack") throw new Error("private-pack"); });
        const afterStagesScored = vi.fn(async () => { if (fail === "stage") throw new Error("private-stage"); });
        const result = await scoreSession(existingPackScore(), "s1", "u1", { afterPackScored, afterStagesScored });
        expect(result.state).toBe("scored");
        expect(afterPackScored).toHaveBeenCalledOnce();
        expect(afterStagesScored).toHaveBeenCalledOnce();
      }
      expect(JSON.stringify(warning.mock.calls)).not.toMatch(/private-pack|private-stage/);
    } finally { warning.mockRestore(); }
  });
});
