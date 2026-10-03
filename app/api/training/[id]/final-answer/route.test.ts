import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEV_USER_HEADER } from "@/server/lib/dev-identity";

import { POST } from "./route";

// POST /api/training/:id/final-answer 集成测试：真实数据库；T05 终答不触发 AI 调用。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

const SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000a1";

// 全量规范种子数据：各测试文件共用同一题目 id，upsert 保证跨文件并发播种结果一致
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

async function newUserWithSession(overrides?: { firstSubmitted?: boolean }) {
  const email = `t05-final-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email } });
  createdUserIds.push(user.id);
  const session = await prisma.trainingSession.create({
    data: {
      userId: user.id,
      questionId: SEED_QUESTION_ID,
      date: new Date(Date.UTC(2026, 9, 3)),
      state: overrides?.firstSubmitted ? "followup" : "reading",
      firstAnswer: overrides?.firstSubmitted ? "首答" : null,
      firstSubmittedAt: overrides?.firstSubmitted ? new Date() : null,
    },
  });
  return { email, sessionId: session.id };
}

function callFinalAnswer(email: string, sessionId: string, body: unknown) {
  const request = new Request(`http://localhost/api/training/${sessionId}/final-answer`, {
    method: "POST",
    headers: { "content-type": "application/json", [DEV_USER_HEADER]: email },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id: sessionId }) });
}

beforeAll(ensureSeedQuestion);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("POST /api/training/:id/final-answer（幂等 / T06 接入点）", () => {
  it("合法提交：200，终答与时间戳落库，状态保持 followup", async () => {
    const { email, sessionId } = await newUserWithSession({ firstSubmitted: true });
    const res = await callFinalAnswer(email, sessionId, { answer: "我的最终答案" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.state).toBe("followup");
    expect(json.data.finalSubmittedAt).toBeTruthy();

    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.finalAnswer).toBe("我的最终答案");
    expect(row.state).toBe("followup");
  });

  it("幂等：重复提交不覆盖终答、时间戳不变", async () => {
    const { email, sessionId } = await newUserWithSession({ firstSubmitted: true });
    const first = await (await callFinalAnswer(email, sessionId, { answer: "原始终答" })).json();
    const second = await (await callFinalAnswer(email, sessionId, { answer: "试图篡改" })).json();
    expect(second.data.finalSubmittedAt).toBe(first.data.finalSubmittedAt);
    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.finalAnswer).toBe("原始终答");
  });

  it("未提交首答：409 FIRST_ANSWER_REQUIRED", async () => {
    const { email, sessionId } = await newUserWithSession();
    const res = await callFinalAnswer(email, sessionId, { answer: "终答" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("FIRST_ANSWER_REQUIRED");
  });

  it("空答案：400 VALIDATION_FAILED", async () => {
    const { email, sessionId } = await newUserWithSession({ firstSubmitted: true });
    const res = await callFinalAnswer(email, sessionId, { answer: "" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("会话 id 非 uuid：400", async () => {
    const { email } = await newUserWithSession({ firstSubmitted: true });
    const res = await callFinalAnswer(email, "not-a-uuid", { answer: "终答" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_SESSION_ID");
  });

  it("限流：超过每用户每分钟额度返回 429（Prd.md 3.5：AI 调用端点限流）", async () => {
    const { email, sessionId } = await newUserWithSession({ firstSubmitted: true });
    // 额度 30 次/分钟：前 30 次放行（幂等返回），第 31 次拒绝
    for (let i = 0; i < 30; i += 1) {
      const res = await callFinalAnswer(email, sessionId, { answer: "终答" });
      expect(res.status).toBe(200);
    }
    const res = await callFinalAnswer(email, sessionId, { answer: "终答" });
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(json.error.retryAfterSeconds).toBeGreaterThan(0);
  });
});
