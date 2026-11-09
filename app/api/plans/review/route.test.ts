import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";
import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";
import { weekStartUtc } from "@/server/modules/planning";

import { GET } from "./route";
import { createReviewGetHandler } from "./handler";

// GET /api/plans/review（T29 / F5 / 蓝图 §2.4）集成测试：真实测试库，无 AI 调用。
// 覆盖：未登录 401、周日前未生成态、周日及之后懒生成并归档 completed、
// 回顾数据口径（完成天数、主攻维度有效分变化）、本人隔离。
// 时间经工厂注入（deps.now，与 planning service 同一测试缝）。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];
const createdQuestionIds: string[] = [];

async function startDeepening(userId: string) {
  await prisma.userProfile.create({ data: { userId, position: "产品经理", yearsExperience: "1-3年", industry: "软件", familiarProducts: [], interestAreas: [], selfAssessment: [] } });
  const question = await prisma.question.create({ data: { kind: "baseline", caseTitle: "基线加深", caseBackground: {}, mainQuestion: "问题", abilityTags: ["问题定义"], difficulty: 1, rubric: {}, hintTree: [], materials: {} } });
  createdQuestionIds.push(question.id);
  await prisma.trainingSession.create({ data: { userId, questionId: question.id, date: new Date(), isExtra: true, sourceType: "baseline", baselineActivatedAt: new Date(), state: "reading" } });
}

async function newUserWithPlanAndSessions() {
  const email = `t29-review-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email } });
  createdUserIds.push(user.id);
  await prisma.abilityProfile.createMany({
    data: ABILITY_DIMENSIONS.map((dimension, index) => ({
      userId: user.id,
      dimension,
      currentScore: 55 + index, // 「问题定义」最低 55
      observationCount: 2,
    })),
  });
  // 本周计划
  const weekStart = weekStartUtc(new Date());
  const plan = await prisma.trainingPlan.create({
    data: {
      userId: user.id,
      weekStartDate: weekStart,
      focusDimension: "问题定义",
      startScore: 55,
      targetScore: 65,
      reason: "「问题定义」是你当前最弱的维度（当前 55 分），本周集中攻它，目标 65 分。",
    },
  });
  // 本周两条 plan 已评分会话（同一天与另一天 → 完成天数 2）+ 一条未评分（不计）
  const question = await prisma.question.create({ data: { caseTitle: "合成题", caseBackground: {}, mainQuestion: "问题", abilityTags: [], difficulty: 1, rubric: {}, hintTree: [], materials: {} } });
  createdQuestionIds.push(question.id);
  const mk = (date: Date, scoredAt: Date | null) =>
    prisma.trainingSession.create({
      data: {
        userId: user.id,
        questionId: question.id,
        date,
        sourceType: "plan",
        sourceId: plan.id,
        scoredAt,
      },
    });
  const a = await mk(weekStart, new Date(weekStart.getTime() + 3600000));
  const b = await mk(new Date(weekStart.getTime() + 2 * 86400000), new Date(weekStart.getTime() + 2 * 86400000 + 3600000));
  await prisma.score.createMany({ data: [a, b].map((session) => ({ sessionId: session.id, dimension: "问题定义", rawScore: 60, hintCount: 0, coefficient: 1, effectiveScore: 60 })) });
  await mk(new Date(weekStart.getTime() + 3 * 86400000), null);
  // 回顾时主攻维度最新有效分：55 → 60
  await prisma.abilityProfile.update({
    where: { userId_dimension: { userId: user.id, dimension: "问题定义" } },
    data: { currentScore: 60 },
  });
  return { email, userId: user.id, plan };
}

async function callReview(email: string | null, now?: Date) {
  const headers: Record<string, string> = {};
  if (email) {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    headers.cookie = sessionCookieHeader(user);
  }
  const handler = now ? createReviewGetHandler({ now }) : GET;
  return handler(new Request("http://localhost/api/plans/review", { method: "GET", headers }));
}

afterAll(async () => {
  await prisma.trainingSession.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.trainingPlan.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.abilityProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.question.deleteMany({ where: { id: { in: createdQuestionIds } } });
  await prisma.$disconnect();
});

describe("GET /api/plans/review：周回顾懒生成与归档（蓝图 §2.4）", () => {
  it("八维已观测但基线加深未完成时不揭晓、不生成快照或归档；完成后可回顾", async () => {
    const { email, userId, plan } = await newUserWithPlanAndSessions();
    await startDeepening(userId);
    const sunday = new Date(plan.weekStartDate.getTime() + 6 * 86400000);
    const blocked = await callReview(email, sunday);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("BASELINE_REQUIRED");
    const untouched = await prisma.trainingPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(untouched.status).toBe("active");
    expect(untouched.reviewSnapshot).toBeNull();
    await prisma.userProfile.update({ where: { userId }, data: { baselineCompletedAt: new Date() } });
    expect((await callReview(email, sunday)).status).toBe(200);
    expect((await prisma.trainingPlan.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe("completed");
  });
  it("未登录：401", async () => {
    const res = await callReview(null);
    expect(res.status).toBe(401);
  });

  it("周日前：未生成态（200 + review=null），计划不归档", async () => {
    const { email, plan } = await newUserWithPlanAndSessions();
    const wednesday = new Date(plan.weekStartDate.getTime() + 2 * 86400000); // 本周三
    const res = await callReview(email, wednesday);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.review).toBeNull();
    const fresh = await prisma.trainingPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(fresh.status).toBe("active"); // 未归档
  });

  it("周日及之后首访：生成周回顾（完成天数 + 有效分变化）并归档 completed；重复调用幂等", async () => {
    const { email, userId, plan } = await newUserWithPlanAndSessions();
    const sunday = new Date(plan.weekStartDate.getTime() + 6 * 86400000); // 本周日
    const res = await callReview(email, sunday);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.review).not.toBeNull();
    expect(json.data.review.plan.id).toBe(plan.id);
    expect(json.data.review.plan.status).toBe("completed");
    expect(json.data.review.completedDays).toBe(2); // 按 date 去重（未评分不计）
    expect(json.data.review.scoredCount).toBe(2);
    expect(json.data.review.startScore).toBe(55);
    expect(json.data.review.latestScore).toBe(60);
    expect(json.data.review.scoreChange).toBe(5);
    // 归档落库
    const fresh = await prisma.trainingPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(fresh.status).toBe("completed");
    // 幂等：再读仍是 completed，不重复写（状态已为 completed，再次调用不报错）
    const again = await callReview(email, sunday);
    expect(again.status).toBe(200);
    expect((await again.json()).data.review.plan.status).toBe("completed");
    expect(await prisma.trainingPlan.count({ where: { userId } })).toBe(1);
  });

  it("本人隔离：A 的周日回顾不影响 B（B 周日前未生成态）", async () => {
    const a = await newUserWithPlanAndSessions();
    const b = await newUserWithPlanAndSessions();
    const sunday = new Date(a.plan.weekStartDate.getTime() + 6 * 86400000);
    await callReview(a.email, sunday);
    const wednesday = new Date(b.plan.weekStartDate.getTime() + 2 * 86400000);
    const resB = await callReview(b.email, wednesday);
    expect((await resB.json()).data.review).toBeNull();
    const freshB = await prisma.trainingPlan.findUniqueOrThrow({ where: { id: b.plan.id } });
    expect(freshB.status).toBe("active");
  });
});
