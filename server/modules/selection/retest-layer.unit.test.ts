import type { PrismaClient, Question, TrainingPlan } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { selectTodayQuestion, type SelectionRepository } from "./service";

const question = {
  id: "question", caseTitle: "测试题", caseBackground: {}, mainQuestion: "问题", abilityTags: ["问题定义"], difficulty: 2,
} as Question;
const repo: SelectionRepository = {
  getProfileView: async () => [{ dimension: "问题定义", observed: true, currentScore: 50, hintDependency: null, hintDependencyBand: null }] as never,
  getProfilePreferences: async () => ({ familiarProducts: [], interestAreas: [] }),
  listPublishedQuestions: async () => [question],
  listSessionHistory: async () => [],
};
const db = {} as PrismaClient;
const deps = { repository: repo, getCurrentPlan: async () => null, hasPlanSessionToday: async () => false };

describe("选题中的复测优先级", () => {
  it("可用计划优先于复测，不创建复测会话", async () => {
    const pickRetest = vi.fn();
    const plan = { id: "plan", status: "active", focusDimension: "问题定义", reason: "本周计划" } as TrainingPlan;
    const result = await selectTodayQuestion(db, "owner", { ...deps, getCurrentPlan: async () => plan, pickRetest });
    expect(result.outcome).toMatchObject({ sourceType: "plan", sourceId: "plan" });
    expect(pickRetest).not.toHaveBeenCalled();
  });

  it("无计划时复用已开复测并解释来源；挂起时继续自适应", async () => {
    const pickRetest = vi.fn().mockResolvedValueOnce({ question, sessionId: "session", triggerId: "trigger", dimension: "问题定义" }).mockResolvedValueOnce(null);
    const selected = await selectTodayQuestion(db, "owner", { ...deps, pickRetest });
    expect(selected).toMatchObject({ retestSessionId: "session", outcome: { sourceType: "retest", sourceId: "trigger", targetDimensions: ["问题定义"] } });
    expect(selected.outcome.reason).toContain("复测验证");
    const ordinary = await selectTodayQuestion(db, "owner", { ...deps, pickRetest });
    expect(ordinary.outcome.sourceType).toBe("daily");
  });

  it("阶段权限或数据库错误不能伪装成普通降级选题", async () => {
    const failure = new Error("stage failed");
    await expect(selectTodayQuestion(db, "owner", { ...deps, pickRetest: async () => { throw failure; } })).rejects.toBe(failure);
  });
});
