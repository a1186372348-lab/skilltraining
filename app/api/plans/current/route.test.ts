import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";
import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";

import { GET } from "./route";

// GET /api/plans/current（T29 / F5 / D30）集成测试：真实测试库，无 AI 调用（规则引擎）。
// 覆盖：未登录 401、懒生成幂等不双写、本人隔离、未知维度待补测态（409 非 500）、进度聚合下发。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];
const createdQuestionIds: string[] = [];

async function startDeepening(userId: string) {
  await prisma.userProfile.create({ data: { userId, position: "产品经理", yearsExperience: "1-3年", industry: "软件", familiarProducts: [], interestAreas: [], selfAssessment: [] } });
  const question = await prisma.question.create({ data: { kind: "baseline", caseTitle: "基线加深", caseBackground: {}, mainQuestion: "问题", abilityTags: ["问题定义"], difficulty: 1, rubric: {}, hintTree: [], materials: {} } });
  createdQuestionIds.push(question.id);
  await prisma.trainingSession.create({ data: { userId, questionId: question.id, date: new Date(), isExtra: true, sourceType: "baseline", baselineActivatedAt: new Date(), state: "reading" } });
}

async function newUser(withFullProfile = true) {
  const email = `t29-current-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email } });
  createdUserIds.push(user.id);
  if (withFullProfile) {
    await prisma.abilityProfile.createMany({
      data: ABILITY_DIMENSIONS.map((dimension, index) => ({
        userId: user.id,
        dimension,
        currentScore: 55 + index, // 55~62 递增：最低分为首位维度「问题定义」
        observationCount: 2,
      })),
    });
  }
  return { email, userId: user.id };
}

async function callCurrent(email?: string) {
  const headers: Record<string, string> = {};
  if (email) {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    headers.cookie = sessionCookieHeader(user);
  }
  return GET(new Request("http://localhost/api/plans/current", { method: "GET", headers }));
}

afterAll(async () => {
  await prisma.trainingPlan.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.abilityProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.question.deleteMany({ where: { id: { in: createdQuestionIds } } });
  await prisma.$disconnect();
});

describe("GET /api/plans/current：懒生成与幂等（D30）", () => {
  it("八维已观测但基线加深未完成时 409，既不揭晓也不生成计划；完成后可生成", async () => {
    const { email, userId } = await newUser();
    await startDeepening(userId);
    const blocked = await callCurrent(email);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("BASELINE_REQUIRED");
    expect(await prisma.trainingPlan.count({ where: { userId } })).toBe(0);
    await prisma.userProfile.update({ where: { userId }, data: { baselineCompletedAt: new Date() } });
    expect((await callCurrent(email)).status).toBe(200);
    expect(await prisma.trainingPlan.count({ where: { userId } })).toBe(1);
  });
  it("未登录：401", async () => {
    const res = await callCurrent();
    expect(res.status).toBe(401);
  });

  it("首访懒生成本周计划：视图含主攻维度（最低分=问题定义）、目标分、理由文案、进度聚合；重复 GET 幂等不双写", async () => {
    const { email, userId } = await newUser();
    const first = await callCurrent(email);
    expect(first.status).toBe(200);
    const json = await first.json();
    expect(json.success).toBe(true);
    expect(json.data.plan.focusDimension).toBe("问题定义"); // 最低分 55
    expect(json.data.plan.startScore).toBe(55);
    expect(json.data.plan.targetScore).toBe(65);
    expect(json.data.plan.status).toBe("active");
    expect(json.data.plan.reason).toContain("问题定义");
    expect(json.data.plan.reason).toContain("55");
    expect(typeof json.data.plan.weekStartDate).toBe("string");
    expect(json.data.progress).toEqual({ scoredCount: 0, completedDays: 0, completedDates: [] });

    // 重复 GET：幂等返回同一计划，不双写
    const second = await callCurrent(email);
    const json2 = await second.json();
    expect(json2.data.plan.id).toBe(json.data.plan.id);
    expect(await prisma.trainingPlan.count({ where: { userId } })).toBe(1);
  });

  it("只返回本人计划（两用户隔离）：B 的计划与 A 不同 id，focusDimension 各自画像", async () => {
    const a = await newUser();
    const b = await newUser();
    const planA = (await (await callCurrent(a.email)).json()).data.plan;
    const planB = (await (await callCurrent(b.email)).json()).data.plan;
    expect(planA.id).not.toBe(planB.id);
    expect(planA.focusDimension).toBe("问题定义");
    expect(planB.focusDimension).toBe("问题定义");
    expect(await prisma.trainingPlan.count({ where: { userId: a.userId } })).toBe(1);
    expect(await prisma.trainingPlan.count({ where: { userId: b.userId } })).toBe(1);
  });

  it("存在未知维度（画像不完整）→ 409 PROFILE_INCOMPLETE 待补测态（非 500），提示先完成基线测评", async () => {
    const { email } = await newUser(false); // 无画像行 → 全部维度未知
    const res = await callCurrent(email);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("PROFILE_INCOMPLETE");
    expect(json.error.message).toContain("基线");
  });
});
