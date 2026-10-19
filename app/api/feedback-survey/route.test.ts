import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";

import { POST } from "./route";

// POST /api/feedback-survey 集成测试：真实数据库。
// 覆盖：zod 校验、落库、幂等（重复提交不覆盖）、D16 第三问计数（4 次不出/第 5 次出）、
// 未评分 409、他人会话 404。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

const SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000a1";

const SEED_QUESTION_DATA = {
  id: SEED_QUESTION_ID,
  caseTitle: "T05 集成测试种子题",
  caseBackground: { product: "测试产品", audience: "测试用户", scenario: "测试场景" },
  mainQuestion: "测试主问题？",
  abilityTags: ["用户理解", "产品价值判断", "产品取舍"],
  difficulty: 2,
  rubric: {
    dimensions: {
      用户理解: ["绝密要点1", "绝密要点2", "绝密要点3"],
      产品价值判断: ["绝密要点1", "绝密要点2", "绝密要点3"],
      产品取舍: ["绝密要点1", "绝密要点2", "绝密要点3"],
    },
    forbidden_leaks: ["绝密结论"],
  },
  hintTree: [1, 2, 3, 4, 5].map((level) => ({
    level,
    stage: `阶段${level}`,
    question: `第${level}层提示`,
  })),
  materials: {
    core: [
      { title: "核心1", source: "测试来源", url: "https://example.com/core-1", summary: "核心摘要1" },
      { title: "核心2", source: "测试来源", url: "https://example.com/core-2", summary: "核心摘要2" },
    ],
    extended: [
      { title: "扩展1", source: "测试来源", url: "https://example.com/ext-1", summary: "扩展摘要1" },
      { title: "扩展2", source: "测试来源", url: "https://example.com/ext-2", summary: "扩展摘要2" },
      { title: "扩展3", source: "测试来源", url: "https://example.com/ext-3", summary: "扩展摘要3" },
    ],
  },
  status: "published" as const,
};

async function ensureSeedQuestion(): Promise<void> {
  const { id, ...data } = SEED_QUESTION_DATA;
  try {
    await prisma.question.upsert({ where: { id }, create: SEED_QUESTION_DATA, update: data });
  } catch {
    // 并发播种冲突：忽略
  }
}

async function newUser(): Promise<{ email: string; userId: string }> {
  const email = `t07-survey-api-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email } });
  createdUserIds.push(user.id);
  return { email, userId: user.id };
}

async function seedSession(
  userId: string,
  state: "reading" | "answering" | "followup" | "scored" = "scored",
): Promise<string> {
  const session = await prisma.trainingSession.create({
    data: {
      userId,
      questionId: SEED_QUESTION_ID,
      date: new Date(Date.UTC(2026, 9, 3)),
      state,
      scoredAt: state === "scored" ? new Date() : null,
    },
  });
  return session.id;
}

async function callSurvey(email: string, body: unknown) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const request = new Request("http://localhost/api/feedback-survey", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: sessionCookieHeader(user) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return POST(request);
}

beforeAll(ensureSeedQuestion);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("POST /api/feedback-survey（校验与落库）", () => {
  it("合法提交：200，两问落库，返回 created=true 与第三问触发标记", async () => {
    const { email, userId } = await newUser();
    const sessionId = await seedSession(userId);
    const res = await callSurvey(email, { sessionId, q1Clarity: 4, q2Next: 5 });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toMatchObject({
      sessionId,
      q1Clarity: 4,
      q2Next: 5,
      periodicQ3: null,
      needsPeriodicQ3: false,
      created: true,
    });
    const row = await prisma.feedbackSurvey.findUniqueOrThrow({ where: { sessionId } });
    expect(row.q1Clarity).toBe(4);
    expect(row.q2Next).toBe(5);
  });

  it("幂等：重复提交 200 且 created=false，原值不被覆盖", async () => {
    const { email, userId } = await newUser();
    const sessionId = await seedSession(userId);
    await callSurvey(email, { sessionId, q1Clarity: 4, q2Next: 4 });
    const res = await callSurvey(email, { sessionId, q1Clarity: 1, q2Next: 1 });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.created).toBe(false);
    expect(json.data.q1Clarity).toBe(4);
    const rows = await prisma.feedbackSurvey.findMany({ where: { sessionId } });
    expect(rows).toHaveLength(1);
  });

  it.each([
    { body: { q1Clarity: 4, q2Next: 5 }, desc: "缺 sessionId" },
    { body: { sessionId: "not-a-uuid", q1Clarity: 4, q2Next: 5 }, desc: "sessionId 非 uuid" },
    { body: { sessionId: randomUUID(), q1Clarity: 0, q2Next: 5 }, desc: "q1 低于下界" },
    { body: { sessionId: randomUUID(), q1Clarity: 4, q2Next: 6 }, desc: "q2 高于上界" },
    { body: { sessionId: randomUUID(), q1Clarity: 2.5, q2Next: 5 }, desc: "q1 非整数" },
    { body: { sessionId: randomUUID(), q1Clarity: 4 }, desc: "缺 q2Next" },
    { body: { sessionId: randomUUID(), q1Clarity: 4, q2Next: 5, periodicQ3: 7 }, desc: "q3 超界" },
  ])("非法请求体（$desc）：400 VALIDATION_FAILED", async ({ body }) => {
    const { email } = await newUser();
    const res = await callSurvey(email, body);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("请求体非 JSON：400 INVALID_JSON", async () => {
    const { email } = await newUser();
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const request = new Request("http://localhost/api/feedback-survey", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookieHeader(user) },
      body: "not-json{",
    });
    const res = await POST(request);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_JSON");
  });

  it("未评分会话：409 SESSION_STATE_INVALID", async () => {
    const { email, userId } = await newUser();
    const sessionId = await seedSession(userId, "followup");
    const res = await callSurvey(email, { sessionId, q1Clarity: 4, q2Next: 4 });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SESSION_STATE_INVALID");
  });

  it("不存在或他人会话：404 SESSION_NOT_FOUND", async () => {
    const { email } = await newUser();
    const { userId: otherId } = await newUser();
    const otherSession = await seedSession(otherId);

    const missing = await callSurvey(email, {
      sessionId: randomUUID(),
      q1Clarity: 4,
      q2Next: 4,
    });
    expect(missing.status).toBe(404);

    const notMine = await callSurvey(email, {
      sessionId: otherSession,
      q1Clarity: 4,
      q2Next: 4,
    });
    expect(notMine.status).toBe(404);
  });
});

describe("POST /api/feedback-survey（D16：每 5 次已评分训练追加周期性一问）", () => {
  it("第 4 次已评分训练：接口返回不需要第三问，携带的 periodicQ3 不落库", async () => {
    const { email, userId } = await newUser();
    await seedSession(userId);
    await seedSession(userId);
    await seedSession(userId);
    const sessionId = await seedSession(userId); // 第 4 次

    const res = await callSurvey(email, { sessionId, q1Clarity: 5, q2Next: 5, periodicQ3: 5 });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.needsPeriodicQ3).toBe(false);
    expect(json.data.periodicQ3).toBeNull();
    const row = await prisma.feedbackSurvey.findUniqueOrThrow({ where: { sessionId } });
    expect(row.periodicQ3).toBeNull();
  });

  it("第 5 次已评分训练：接口返回需要第三问，periodicQ3 落库", async () => {
    const { email, userId } = await newUser();
    for (let i = 0; i < 4; i += 1) await seedSession(userId);
    const sessionId = await seedSession(userId); // 第 5 次

    const res = await callSurvey(email, { sessionId, q1Clarity: 4, q2Next: 4, periodicQ3: 3 });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.needsPeriodicQ3).toBe(true);
    expect(json.data.periodicQ3).toBe(3);
    const row = await prisma.feedbackSurvey.findUniqueOrThrow({ where: { sessionId } });
    expect(row.periodicQ3).toBe(3);
  });
});
