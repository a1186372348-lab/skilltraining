import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";

import { POST } from "./route";

// POST /api/training/:id/followup-retry（T37 / D39）集成测试：真实数据库；
// AI 追问经 vi.mock 拦截（测试一律 mock AI，不出网）。

const generateFollowupsMock = vi.fn(async () => [
  { question: "证据是什么？", hint: "想想可衡量的指标" },
  { question: "反方如何反驳？", hint: "站在反方立场找论据" },
]);
vi.mock("@/server/ai/followup", () => ({
  generateFollowups: (...args: unknown[]) => generateFollowupsMock(...(args as [])),
}));

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

/** 追问生成失败态会话：state=followup、已提交首答、followups 为空数组 */
async function newUserWithFailedSession() {
  const email = `t37-retry-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email } });
  createdUserIds.push(user.id);
  const session = await prisma.trainingSession.create({
    data: {
      userId: user.id,
      questionId: SEED_QUESTION_ID,
      date: new Date(Date.UTC(2026, 9, 14)),
      state: "followup",
      firstAnswer: "我的首次答案",
      firstSubmittedAt: new Date(),
      followups: [],
    },
  });
  return { email, userId: user.id, sessionId: session.id };
}

async function callRetry(email: string | null, sessionId: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (email !== null) {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    headers.cookie = sessionCookieHeader(user);
  }
  const request = new Request(`http://localhost/api/training/${sessionId}/followup-retry`, {
    method: "POST",
    headers,
  });
  return POST(request, { params: Promise.resolve({ id: sessionId }) });
}

beforeAll(ensureSeedQuestion);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("POST /api/training/:id/followup-retry（T37 / D39）", () => {
  it("未登录：401 UNAUTHORIZED", async () => {
    const { sessionId } = await newUserWithFailedSession();
    const res = await callRetry(null, sessionId);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("他人会话：404 SESSION_NOT_FOUND（不泄露存在性）", async () => {
    const { sessionId } = await newUserWithFailedSession();
    const stranger = `t37-stranger-${randomUUID()}@example.com`;
    const user = await prisma.user.create({ data: { email: stranger } });
    createdUserIds.push(user.id);
    const res = await callRetry(stranger, sessionId);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SESSION_NOT_FOUND");
  });

  it("会话 id 非 uuid：400 INVALID_SESSION_ID", async () => {
    const { email } = await newUserWithFailedSession();
    const res = await callRetry(email, "not-a-uuid");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_SESSION_ID");
  });

  it("状态不符（未提交首答）：409 INVALID_STATE", async () => {
    const email = `t37-state-${randomUUID()}@example.com`;
    const user = await prisma.user.create({ data: { email } });
    createdUserIds.push(user.id);
    const session = await prisma.trainingSession.create({
      data: {
        userId: user.id,
        questionId: SEED_QUESTION_ID,
        date: new Date(Date.UTC(2026, 9, 14)),
        state: "answering",
      },
    });
    const res = await callRetry(email, session.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("INVALID_STATE");
  });

  it("已提交终答：409 INVALID_STATE（训练已结束，不再生成追问）", async () => {
    const email = `t37-final-${randomUUID()}@example.com`;
    const user = await prisma.user.create({ data: { email } });
    createdUserIds.push(user.id);
    const session = await prisma.trainingSession.create({
      data: {
        userId: user.id,
        questionId: SEED_QUESTION_ID,
        date: new Date(Date.UTC(2026, 9, 14)),
        state: "followup",
        firstAnswer: "首答",
        firstSubmittedAt: new Date(),
        followups: [],
        finalAnswer: "终答",
        finalSubmittedAt: new Date(),
      },
    });
    const res = await callRetry(email, session.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("INVALID_STATE");
  });

  it("幂等：followups 非空时直接返回既有追问，不重复调 AI", async () => {
    const email = `t37-idem-${randomUUID()}@example.com`;
    const user = await prisma.user.create({ data: { email } });
    createdUserIds.push(user.id);
    const session = await prisma.trainingSession.create({
      data: {
        userId: user.id,
        questionId: SEED_QUESTION_ID,
        date: new Date(Date.UTC(2026, 9, 14)),
        state: "followup",
        firstAnswer: "首答",
        firstSubmittedAt: new Date(),
        followups: [{ round: 1, question: "既有追问", hint: "既有提示", hintReleased: false }],
      },
    });
    generateFollowupsMock.mockClear();
    const res = await callRetry(email, session.id);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.followups).toEqual([
      { round: 1, question: "既有追问", hasHint: true, hintReleased: false, hint: null },
    ]);
    expect(generateFollowupsMock).not.toHaveBeenCalled();
  });

  it("成功：失败态会话重新生成追问并落库（含预生成提示，D22）", async () => {
    const { email, sessionId } = await newUserWithFailedSession();
    generateFollowupsMock.mockClear();
    const res = await callRetry(email, sessionId);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.state).toBe("followup");
    // 响应与首答接口的追问视图同构：未释放的提示不下发明文（FR-10 / D22）
    expect(json.data.followups).toEqual([
      { round: 1, question: "证据是什么？", hasHint: true, hintReleased: false, hint: null },
      { round: 2, question: "反方如何反驳？", hasHint: true, hintReleased: false, hint: null },
    ]);
    expect(typeof json.data.coefficient).toBe("number");
    expect(typeof json.data.firstSubmittedAt).toBe("string");
    expect(generateFollowupsMock).toHaveBeenCalledTimes(1);

    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.followups).toEqual([
      { round: 1, question: "证据是什么？", hint: "想想可衡量的指标", hintReleased: false },
      { round: 2, question: "反方如何反驳？", hint: "站在反方立场找论据", hintReleased: false },
    ]);
  });

  it("再次失败：返回 200 + 空 followups（语义与首答一致，前端按失败态处理）", async () => {
    const { email, sessionId } = await newUserWithFailedSession();
    generateFollowupsMock.mockRejectedValueOnce(new Error("AI 网关故障"));
    const res = await callRetry(email, sessionId);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.followups).toEqual([]);
    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.followups).toEqual([]);
  });

  it("限流：同一用户 1 分钟内第 31 次请求返回 429 RATE_LIMITED", async () => {
    const email = `t37-ratelimit-${randomUUID()}@example.com`;
    const user = await prisma.user.create({ data: { email } });
    createdUserIds.push(user.id);
    // followups 非空：30 次调用全部走幂等快速路径（不重复调 AI）
    const session = await prisma.trainingSession.create({
      data: {
        userId: user.id,
        questionId: SEED_QUESTION_ID,
        date: new Date(Date.UTC(2026, 9, 14)),
        state: "followup",
        firstAnswer: "首答",
        firstSubmittedAt: new Date(),
        followups: [{ round: 1, question: "既有追问", hint: "", hintReleased: false }],
      },
    });
    let lastRes: Response | null = null;
    for (let i = 0; i < 30; i += 1) {
      lastRes = await callRetry(email, session.id);
      expect(lastRes.status).toBe(200);
    }
    lastRes = await callRetry(email, session.id);
    expect(lastRes.status).toBe(429);
    expect((await lastRes.json()).error.code).toBe("RATE_LIMITED");
  });
});
