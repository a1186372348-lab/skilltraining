import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaPlanningRepository } from "./repository";

// planning 仓储集成测试（T29 / F5）：真实测试库（vitest.setup 强制 skilltraining_test，
// pretest 已 migrate deploy training_plans 表）。覆盖表读写与 @@unique 唯一约束幂等兜底。

const prisma = new PrismaClient();
let userId: string;
let questionId: string;

const WEEK = new Date(Date.UTC(2026, 9, 19)); // 2026-10-19 周一
const NEXT_WEEK = new Date(Date.UTC(2026, 9, 26)); // 下周一

function planData(weekStartDate: Date, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    weekStartDate,
    focusDimension: "产品取舍",
    startScore: 55,
    targetScore: 65,
    reason: "「产品取舍」是你当前最弱的维度（当前 55 分），本周集中攻它，目标 65 分。",
    ...overrides,
  };
}

beforeAll(async () => {
  const user = await prisma.user.create({ data: { email: `t29-repo-${randomUUID()}@example.com` } });
  userId = user.id;
  questionId = (await prisma.question.create({ data: { caseTitle: "合成题", caseBackground: {}, mainQuestion: "问题", abilityTags: [], difficulty: 1, rubric: {}, hintTree: [], materials: {} } })).id;
});

afterAll(async () => {
  await prisma.trainingPlan.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } }); // 级联兜底
  await prisma.question.delete({ where: { id: questionId } });
  await prisma.$disconnect();
});

describe("createPrismaPlanningRepository：training_plans 读写", () => {
  it("创建后按周可读（findPlanByWeek 命中），字段原样落库", async () => {
    const repo = createPrismaPlanningRepository(prisma);
    const created = await repo.createPlan(planData(WEEK));
    expect(created.status).toBe("active"); // 默认 active
    expect(created.createdAt).toBeInstanceOf(Date);

    const found = await repo.findPlanByWeek(userId, WEEK);
    expect(found?.id).toBe(created.id);
    expect(found?.focusDimension).toBe("产品取舍");
    expect(found?.startScore).toBe(55);
    expect(found?.targetScore).toBe(65);
    expect(found?.reason).toContain("产品取舍");

    // 其他周不命中
    expect(await repo.findPlanByWeek(userId, NEXT_WEEK)).toBeNull();
  });

  it("唯一约束：同用户同周重复创建抛 P2002（懒生成幂等的库层兜底）", async () => {
    const repo = createPrismaPlanningRepository(prisma);
    await expect(repo.createPlan(planData(WEEK, { focusDimension: "用户理解" }))).rejects.toMatchObject({
      code: "P2002",
    });
    // 不同周可建
    const next = await repo.createPlan(planData(NEXT_WEEK, { focusDimension: "用户理解" }));
    expect(next.weekStartDate.getTime()).toBe(NEXT_WEEK.getTime());
  });

  it("findLatestPlan 返回最近一期；updatePlanStatus 推进状态", async () => {
    const repo = createPrismaPlanningRepository(prisma);
    const latest = await repo.findLatestPlan(userId);
    expect(latest?.weekStartDate.getTime()).toBe(NEXT_WEEK.getTime());

    const rejected = await repo.updatePlanStatus(latest!.id, "rejected");
    expect(rejected.status).toBe("rejected");
    const reread = await repo.findPlanByWeek(userId, NEXT_WEEK);
    expect(reread?.status).toBe("rejected");
  });
});

describe("listPlanScoredSessions：本周 plan 已评分会话（进度聚合事实源）", () => {
  it("只命中本周 + sourceType=plan + 已评分；其他来源/未评分/跨周不命中", async () => {
    const repo = createPrismaPlanningRepository(prisma);
    // 切片 1 已迁移 sourceType 列；测试直接写列值构造数据（切片 3 才由业务代码真实写入）
    const qid = questionId;
    const mk = (overrides: {
      date: Date;
      sourceType: "daily" | "extra" | "baseline" | "plan";
      scoredAt?: Date | null;
    }) =>
      prisma.trainingSession.create({
        data: {
          userId,
          questionId: qid,
          date: overrides.date,
          sourceType: overrides.sourceType,
          sourceId: "00000000-0000-4000-8000-000000000001",
          scoredAt: overrides.scoredAt ?? null,
        },
      });
    await mk({ date: new Date(Date.UTC(2026, 9, 20)), sourceType: "plan", scoredAt: new Date(Date.UTC(2026, 9, 20)) }); // 命中
    await mk({ date: new Date(Date.UTC(2026, 9, 22)), sourceType: "plan", scoredAt: new Date(Date.UTC(2026, 9, 22)) }); // 命中
    await mk({ date: new Date(Date.UTC(2026, 9, 21)), sourceType: "plan" }); // 未评分不命中
    await mk({ date: new Date(Date.UTC(2026, 9, 20)), sourceType: "daily", scoredAt: new Date() }); // 非 plan 不命中
    await mk({ date: new Date(Date.UTC(2026, 9, 27)), sourceType: "plan", scoredAt: new Date(Date.UTC(2026, 9, 27)) }); // 跨周不命中

    const rows = await repo.listPlanScoredSessions(userId, WEEK, "00000000-0000-4000-8000-000000000001");
    expect(rows.map((r) => r.scoredAt.toISOString().slice(0, 10)).sort()).toEqual(["2026-10-20", "2026-10-22"]);
  });
});

describe("周回顾快照并发", () => {
  it("并发写入只保留第一个快照且不覆盖拒绝状态", async () => {
    const repo = createPrismaPlanningRepository(prisma);
    const week = new Date(Date.UTC(2026, 10, 2));
    const plan = await repo.createPlan(planData(week));
    await repo.updatePlanStatus(plan.id, "rejected");
    const snapshot = { schemaVersion: 1 as const, generatedAt: "2026-11-09T00:00:00.000Z", scoredCount: 0,
      completedDays: 0, completedDates: [], startScore: 55, latestScore: 60, scoreChange: 5 };
    const [a, b] = await Promise.all([
      repo.saveReviewSnapshot(userId, plan, snapshot),
      repo.saveReviewSnapshot(userId, plan, { ...snapshot, latestScore: 70, scoreChange: 15 }),
    ]);
    expect(a.reviewSnapshot).toEqual(b.reviewSnapshot);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
  });
});