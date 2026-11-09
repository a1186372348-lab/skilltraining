import { randomUUID } from "node:crypto";
import { PrismaClient, type TrainingSessionSource } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getOrCreateCurrentPlan, getOrGenerateWeeklyReview, getPlanProgress, setCurrentPlanStatus } from "./service";

const db = new PrismaClient();
const week = new Date("2026-10-19T00:00:00.000Z");
const next = new Date("2026-10-26T00:00:00.000Z");
let userId: string;
let otherId: string;
let questionId: string;

beforeAll(async () => {
  userId = (await db.user.create({ data: { email: `t29-${randomUUID()}@example.com` } })).id;
  otherId = (await db.user.create({ data: { email: `t29-${randomUUID()}@example.com` } })).id;
  questionId = (await db.question.create({ data: { caseTitle: "合成题", caseBackground: {}, mainQuestion: "问题", abilityTags: [], difficulty: 1, rubric: {}, hintTree: [], materials: {} } })).id;
});
afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
  await db.question.deleteMany({ where: { id: questionId } });
  await db.$disconnect();
});

async function session(user: string, date: string, scored: string, source: TrainingSessionSource, sourceId: string | null, score: number) {
  return db.trainingSession.create({ data: {
    userId: user, questionId, date: new Date(date), scoredAt: new Date(scored), sourceType: source, sourceId,
    scores: { create: { dimension: "问题定义", rawScore: score, hintCount: 0, coefficient: 1, effectiveScore: score } },
  } });
}

describe("计划实际完成与历史快照", () => {
  it("UTC 边界、用户及计划隔离，所有训练来源计入累计有效分；首次回顾并发后不漂移", async () => {
    const plan = await db.trainingPlan.create({ data: { userId, weekStartDate: week, focusDimension: "问题定义", startScore: 50, targetScore: 60, reason: "测试" } });
    await session(userId, "2026-10-18", "2026-10-19T00:00:00Z", "plan", plan.id, 40);
    await session(userId, "2026-10-19", "2026-10-25T23:59:59Z", "plan", plan.id, 60);
    await session(userId, "2026-10-20", "2026-10-20T10:00:00Z", "extra", null, 80);
    await session(userId, "2026-10-21", "2026-10-21T10:00:00Z", "plan", randomUUID(), 20);
    await session(userId, "2026-10-22", "2026-10-22T10:00:00Z", "baseline", null, 50);
    await session(otherId, "2026-10-22", "2026-10-22T10:00:00Z", "plan", plan.id, 100);
    await session(userId, "2026-10-25", "2026-10-26T00:00:00Z", "plan", plan.id, 100);
    expect(await getPlanProgress(db, userId, plan)).toEqual({ scoredCount: 2, completedDays: 2, completedDates: ["2026-10-19", "2026-10-25"] });
    await db.trainingPlan.create({ data: { userId, weekStartDate: next, focusDimension: "问题定义", startScore: 50, targetScore: 60, reason: "新周" } });
    expect((await getOrCreateCurrentPlan(db, userId, { now: next })).weekStartDate).toEqual(next);
    const [first, concurrent] = await Promise.all([
      getOrGenerateWeeklyReview(db, userId, { now: next }),
      getOrGenerateWeeklyReview(db, userId, { now: next }),
    ]);
    expect(first?.plan.id).toBe(plan.id);
    expect(first?.latestScore).toBe(50);
    expect(first?.completedDays).toBe(2);
    expect(concurrent).toEqual(first);
    await session(userId, "2026-10-23", "2026-10-23T10:00:00Z", "daily", null, 100);
    // 调用方仍持有封存前的 plan；迟到的旧周 plan 评分不能改变已封存进度。
    await session(userId, "2026-10-23", "2026-10-23T10:00:00Z", "plan", plan.id, 90);
    expect(await getPlanProgress(db, userId, plan)).toEqual({ scoredCount: 2, completedDays: 2, completedDates: ["2026-10-19", "2026-10-25"] });
    expect(await getOrGenerateWeeklyReview(db, userId, { now: new Date("2026-10-27T00:00:00Z") })).toEqual(first);
  });
  it("归档后旧拒绝或撤销请求不能重新改变计划", async () => {
    const sunday = new Date("2026-11-01T12:00:00Z");
    const plan = await db.trainingPlan.create({ data: { userId: otherId, weekStartDate: next, focusDimension: "问题定义", startScore: 50, targetScore: 60, reason: "测试" } });
    await getOrGenerateWeeklyReview(db, otherId, { now: sunday });
    for (const status of ["rejected", "active"] as const) {
      await expect(setCurrentPlanStatus(db, otherId, status, { now: sunday })).rejects.toMatchObject({ code: "PLAN_COMPLETED" });
    }
    expect((await db.trainingPlan.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe("completed");
  });

  it("并发周回顾和拒绝时，成功拒绝不被归档覆盖", async () => {
    const monday = new Date("2026-11-02T00:00:00Z");
    const sunday = new Date("2026-11-08T12:00:00Z");
    const plan = await db.trainingPlan.create({ data: { userId: otherId, weekStartDate: monday, focusDimension: "问题定义", startScore: 50, targetScore: 60, reason: "测试" } });
    const [, rejection] = await Promise.allSettled([
      getOrGenerateWeeklyReview(db, otherId, { now: sunday }),
      setCurrentPlanStatus(db, otherId, "rejected", { now: sunday }),
    ]);
    const saved = await db.trainingPlan.findUniqueOrThrow({ where: { id: plan.id } });
    if (rejection.status === "fulfilled") expect(saved.status).toBe("rejected");
    else expect(saved.status).toBe("completed");
    expect(saved.reviewSnapshot).not.toBeNull();
  });

});
