import type { PrismaClient, TrainingPlan } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { selectTodayQuestion, type SelectionRepository } from "./service";

const questions = ["reserved", "other"].map(id => ({
  id, caseTitle: id, caseBackground: {}, mainQuestion: "问题", abilityTags: ["问题定义"], difficulty: 2,
}));

function repository(): SelectionRepository {
  return {
    getProfileView: async () => [],
    getProfilePreferences: async () => ({ familiarProducts: [], interestAreas: [] }),
    listPublishedQuestions: async () => questions,
    listSessionHistory: async () => [],
  };
}

describe("加练不得占用训练包预留题", () => {
  it("即使计划维度首先匹配预留题，也选择其他题", async () => {
    const plan = { id: "plan-1", status: "active", focusDimension: "问题定义", reason: "本周计划" } as TrainingPlan;
    const result = await selectTodayQuestion({} as PrismaClient, "user-1", {
      repository: repository(), getCurrentPlan: async () => plan, hasPlanSessionToday: async () => false,
      excludedQuestionIds: ["reserved"],
    } as never);
    expect(result.question.id).toBe("other");
  });

  it("选题降级和重练也不能取预留题", async () => {
    const findFirst = vi.fn(async ({ where }: { where: { id?: { notIn?: string[] } } }) =>
      questions.find(q => !where.id?.notIn?.includes(q.id)) ?? null,
    );
    const db = { trainingSession: { findMany: async () => [{ questionId: "other" }] }, question: { findFirst } } as unknown as PrismaClient;
    const broken = { ...repository(), getProfileView: async () => { throw new Error("unavailable"); } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await selectTodayQuestion(db, "user-1", {
        repository: broken, getCurrentPlan: async () => null, hasPlanSessionToday: async () => false,
        excludedQuestionIds: ["reserved"],
      } as never);
      expect(result.question.id).toBe("other");
      expect(result.degraded).toBe(true);
    } finally { warn.mockRestore(); }
  });
});
