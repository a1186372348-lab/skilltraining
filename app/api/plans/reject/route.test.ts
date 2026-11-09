import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";
import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";

import { POST } from "./route";
import { createRejectPostHandler } from "./handler";
import { getOrGenerateWeeklyReview } from "@/server/modules/planning";
import { GET } from "../current/route";

// POST /api/plans/reject（T29 / F5 / D33② / BR-V2-2）集成测试：真实测试库。
// 覆盖：未登录 401、非法 body 400、reject/unreject 幂等且本周生效、无计划 404、本人隔离。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];
const createdQuestionIds: string[] = [];

async function startDeepening(userId: string) {
  await prisma.userProfile.create({ data: { userId, position: "产品经理", yearsExperience: "1-3年", industry: "软件", familiarProducts: [], interestAreas: [], selfAssessment: [] } });
  const question = await prisma.question.create({ data: { kind: "baseline", caseTitle: "基线加深", caseBackground: {}, mainQuestion: "问题", abilityTags: ["问题定义"], difficulty: 1, rubric: {}, hintTree: [], materials: {} } });
  createdQuestionIds.push(question.id);
  await prisma.trainingSession.create({ data: { userId, questionId: question.id, date: new Date(), isExtra: true, sourceType: "baseline", baselineActivatedAt: new Date(), state: "reading" } });
}

async function newUserWithPlan() {
  const email = `t29-reject-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email } });
  createdUserIds.push(user.id);
  await prisma.abilityProfile.createMany({
    data: ABILITY_DIMENSIONS.map((dimension, index) => ({
      userId: user.id,
      dimension,
      currentScore: 55 + index,
      observationCount: 2,
    })),
  });
  // 经 current 懒生成本周计划
  const req = new Request("http://localhost/api/plans/current", {
    method: "GET",
    headers: { cookie: sessionCookieHeader(user) },
  });
  await GET(req);
  return { email, userId: user.id };
}

async function callReject(email: string | null, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (email) {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    headers.cookie = sessionCookieHeader(user);
  }
  return POST(
    new Request("http://localhost/api/plans/reject", {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function currentPlan(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const res = await GET(
    new Request("http://localhost/api/plans/current", {
      method: "GET",
      headers: { cookie: sessionCookieHeader(user) },
    }),
  );
  return (await res.json()).data.plan;
}

afterAll(async () => {
  await prisma.trainingPlan.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.abilityProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.question.deleteMany({ where: { id: { in: createdQuestionIds } } });
  await prisma.$disconnect();
});

describe("POST /api/plans/reject：拒绝与撤销（幂等，本周生效）", () => {
  it("八维已观测但基线加深未完成时 409，不揭晓分数且不更改计划状态；完成后可操作", async () => {
    const { email, userId } = await newUserWithPlan();
    await startDeepening(userId);
    const blocked = await callReject(email, { action: "reject" });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("BASELINE_REQUIRED");
    expect((await prisma.trainingPlan.findFirstOrThrow({ where: { userId } })).status).toBe("active");
    await prisma.userProfile.update({ where: { userId }, data: { baselineCompletedAt: new Date() } });
    expect((await callReject(email, { action: "reject" })).status).toBe(200);
    expect((await prisma.trainingPlan.findFirstOrThrow({ where: { userId } })).status).toBe("rejected");
  });
  it("未登录：401", async () => {
    const res = await callReject(null, { action: "reject" });
    expect(res.status).toBe(401);
  });

  it("拒绝计划周日生成回顾后仍可同周撤销，快照不变", async () => {
    const { email, userId } = await newUserWithPlan();
    const plan = await prisma.trainingPlan.findFirstOrThrow({ where: { userId } });
    const sunday = new Date(plan.weekStartDate.getTime() + 6 * 86400000 + 3600000);
    await prisma.trainingPlan.update({ where: { id: plan.id }, data: { status: "rejected" } });
    const before = await getOrGenerateWeeklyReview(prisma, userId, { now: sunday });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const handler = createRejectPostHandler({ now: sunday });
    const res = await handler(new Request("http://localhost/api/plans/reject", {
      method: "POST", headers: { cookie: sessionCookieHeader(user), "content-type": "application/json" },
      body: JSON.stringify({ action: "unreject" }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.plan.status).toBe("active");
    const after = await prisma.trainingPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(after.reviewSnapshot).toEqual(before?.plan.reviewSnapshot);
  });

  it("已归档计划拒绝旧按钮请求并保持终态", async () => {
    const { email, userId } = await newUserWithPlan();
    await prisma.trainingPlan.updateMany({ where: { userId }, data: { status: "completed" } });
    for (const action of ["reject", "unreject"]) {
      const res = await callReject(email, { action });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("PLAN_COMPLETED");
    }
    expect((await currentPlan(email)).status).toBe("completed");
  });

  it("非法 body：400 VALIDATION_FAILED（action 须为 reject/unreject）", async () => {
    const { email } = await newUserWithPlan();
    for (const body of [{}, { action: "nope" }, { action: 42 }, "不是对象"]) {
      const res = await callReject(email, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("reject → active 变 rejected 且本周生效（GET current 反映）；重复 reject 幂等", async () => {
    const { email, userId } = await newUserWithPlan();
    const res = await callReject(email, { action: "reject" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.plan.status).toBe("rejected");
    expect((await currentPlan(email)).status).toBe("rejected");

    // 幂等：重复 reject 返回当前态，不产生副作用（行数不变）
    const again = await callReject(email, { action: "reject" });
    expect(again.status).toBe(200);
    expect((await again.json()).data.plan.status).toBe("rejected");
    expect(await prisma.trainingPlan.count({ where: { userId } })).toBe(1);
  });

  it("unreject：rejected → active 恢复；active 时 unreject 幂等", async () => {
    const { email } = await newUserWithPlan();
    await callReject(email, { action: "reject" });
    const restored = await callReject(email, { action: "unreject" });
    expect(restored.status).toBe(200);
    expect((await restored.json()).data.plan.status).toBe("active");
    expect((await currentPlan(email)).status).toBe("active");
    // 幂等：active 状态下 unreject 不报错
    const again = await callReject(email, { action: "unreject" });
    expect(again.status).toBe(200);
  });

  it("本人隔离：A 拒绝不影响 B 的计划", async () => {
    const a = await newUserWithPlan();
    const b = await newUserWithPlan();
    await callReject(a.email, { action: "reject" });
    expect((await currentPlan(b.email)).status).toBe("active");
  });

  it("无本周计划（画像不完整未生成）：404 PLAN_NOT_FOUND", async () => {
    const email = `t29-reject-none-${randomUUID()}@example.com`;
    const user = await prisma.user.create({ data: { email } });
    createdUserIds.push(user.id);
    const res = await callReject(email, { action: "reject" });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("PLAN_NOT_FOUND");
  });
});
