import type { PrismaClient, TrainingPlan } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { createPrismaPlanningRepository } from "./repository";
import { getPlanProgress } from "./service";

describe("训练包与计划进度", () => {
  it("按本人及 UTC 评分窗口同时查询旧 plan 会话和绑定该计划的 pack 会话", async () => {
    const findMany = vi.fn(async () => [{ scoredAt: new Date("2026-10-20T12:00:00Z") }]);
    const repo = createPrismaPlanningRepository({ trainingSession: { findMany } } as unknown as PrismaClient);
    const start = new Date("2026-10-19T00:00:00Z");
    await repo.listPlanScoredSessions("user-1", start, "plan-1");
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      userId: "user-1", scoredAt: { gte: start, lt: new Date("2026-10-26T00:00:00Z") },
      OR: [{ sourceType: "plan", sourceId: "plan-1" }, { sourceType: "pack", linkedPlanId: "plan-1" }],
    }) }));
  });

  it("已封存回顾的首页进度使用同一快照而非重新聚合", async () => {
    const list = vi.fn(async () => [{ scoredAt: new Date("2026-10-25T16:00:00Z") }]);
    const snapshot = {
      schemaVersion: 1, generatedAt: "2026-10-25T09:00:00.000Z", scoredCount: 2,
      completedDays: 1, completedDates: ["2026-10-23"], startScore: 60, latestScore: 65, scoreChange: 5,
    };
    const plan = { id: "plan-1", weekStartDate: new Date("2026-10-19T00:00:00Z"), reviewSnapshot: snapshot } as unknown as TrainingPlan;
    const progress = await getPlanProgress({} as PrismaClient, "user-1", plan, { repository: { findPlanById: async () => plan, listPlanScoredSessions: list } as never });
    expect(progress).toEqual({ scoredCount: 2, completedDays: 1, completedDates: ["2026-10-23"] });
    expect(list).not.toHaveBeenCalled();
  });
});
