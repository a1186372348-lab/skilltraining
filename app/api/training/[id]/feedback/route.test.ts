import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";
import type { RubricScoringInput, RubricScoringOutput } from "@/server/modules/scoring/rubric-scorer";

import { createFeedbackGetHandler } from "./route";

// GET /api/training/[id]/feedback 集成测试：真实数据库，AI 评分经工厂注入 mock（真实冒烟 0 次）。
// 覆盖：懒触发（200 scoring → 后台评分 → 200 ready）、幂等（重复 GET 不重复评分）、
// 四元组装配、参数/状态/归属校验、AI 端点限流（Prd.md 3.5）。

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

function fakeScorer(rawScores: Record<string, number>, tracker?: { calls: number }) {
  return async (input: RubricScoringInput): Promise<RubricScoringOutput> => {
    if (tracker) tracker.calls += 1;
    return {
      dimensions: Object.keys(input.rubricDimensions).map((dimension) => ({
        dimension,
        rawScore: rawScores[dimension] ?? 70,
        diagnosis: `${dimension}诊断：引用了终答中的具体证据。`,
      })),
      topIssue: "终答缺少量化指标，应补充衡量口径。",
      nextFocus: "下一步练「产品价值判断」中的价值量化类问题。",
    };
  };
}

async function newUserWithSession(overrides?: {
  state?: "reading" | "answering" | "followup" | "scored";
  hintCount?: number;
}) {
  const email = `t07-feedback-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email } });
  createdUserIds.push(user.id);
  const state = overrides?.state ?? "followup";
  const finished = state === "followup" || state === "scored";
  const session = await prisma.trainingSession.create({
    data: {
      userId: user.id,
      questionId: SEED_QUESTION_ID,
      date: new Date(Date.UTC(2026, 9, 3)),
      state,
      hintCount: overrides?.hintCount ?? 0,
      firstAnswer: finished ? "首答" : null,
      firstSubmittedAt: finished ? new Date() : null,
      finalAnswer: finished ? "终答" : null,
      finalSubmittedAt: finished ? new Date() : null,
    },
  });
  return { email, sessionId: session.id };
}

async function waitForScores(sessionId: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    const count = await prisma.score.count({ where: { sessionId } });
    if (count > 0) return;
    if (Date.now() - start > 3000) throw new Error("等待评分落库超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const GET = createFeedbackGetHandler({
  scoreWithRubric: fakeScorer({ 用户理解: 85, 产品价值判断: 90, 产品取舍: 70 }),
});

async function callFeedback(email: string, sessionId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const request = new Request(`http://localhost/api/training/${sessionId}/feedback`, {
    headers: { cookie: sessionCookieHeader(user) },
  });
  return GET(request, { params: Promise.resolve({ id: sessionId }) });
}

beforeAll(ensureSeedQuestion);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("GET /api/training/:id/feedback（懒触发与轮询）", () => {
  it("未评分会话：200 scoring；后台评分完成后 200 ready，四元组装配正确", async () => {
    const { email, sessionId } = await newUserWithSession({ hintCount: 2 });

    const first = await callFeedback(email, sessionId);
    expect(first.status).toBe(200);
    const scoring = await first.json();
    expect(scoring.success).toBe(true);
    expect(scoring.data).toEqual({ status: "scoring", sessionId });

    await waitForScores(sessionId);

    const res = await callFeedback(email, sessionId);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe("ready");
    expect(json.data.scores).toHaveLength(3);
    expect(json.data.scores[0]).toMatchObject({
      dimension: "用户理解",
      rawScore: 85,
      hintCount: 2,
      coefficient: 0.8,
      effectiveScore: 68,
    });
    expect(json.data.topIssueText).toContain("量化指标");
    expect(json.data.nextFocusText).toContain("产品价值判断");
    expect(json.data.survey).toEqual({ submitted: false, needsPeriodicQ3: false });
  });

  it("幂等：已评分会话重复 GET 不重复评分（AI 全程只调一次）", async () => {
    const tracker = { calls: 0 };
    const trackedGET = createFeedbackGetHandler({
      scoreWithRubric: fakeScorer({ 用户理解: 80 }, tracker),
    });
    const email = `t07-feedback-${randomUUID()}@example.com`;
    const user = await prisma.user.create({ data: { email } });
    createdUserIds.push(user.id);
    const session = await prisma.trainingSession.create({
      data: {
        userId: user.id,
        questionId: SEED_QUESTION_ID,
        date: new Date(Date.UTC(2026, 9, 3)),
        state: "followup",
        firstAnswer: "首答",
        firstSubmittedAt: new Date(),
        finalAnswer: "终答",
        finalSubmittedAt: new Date(),
      },
    });
    const call = () =>
      trackedGET(
        new Request(`http://localhost/api/training/${session.id}/feedback`, {
          headers: { cookie: sessionCookieHeader(user) },
        }),
        { params: Promise.resolve({ id: session.id }) },
      );

    await call();
    await waitForScores(session.id);
    const again1 = await (await call()).json();
    const again2 = await (await call()).json();
    expect(again1.data.status).toBe("ready");
    expect(again2.data.status).toBe("ready");
    expect(again1.data.scores).toEqual(again2.data.scores);
    expect(tracker.calls).toBe(1);
  });

  it("会话 id 非 uuid：400 INVALID_SESSION_ID", async () => {
    const { email } = await newUserWithSession();
    const res = await callFeedback(email, "not-a-uuid");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_SESSION_ID");
  });

  it("不存在或他人会话：404 SESSION_NOT_FOUND", async () => {
    const { email, sessionId } = await newUserWithSession();
    const stranger = `t07-feedback-${randomUUID()}@example.com`;
    const user = await prisma.user.create({ data: { email: stranger } });
    createdUserIds.push(user.id);

    const missing = await callFeedback(email, randomUUID());
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("SESSION_NOT_FOUND");

    const notMine = await callFeedback(stranger, sessionId);
    expect(notMine.status).toBe(404);
  });

  it("作答流程未走完（reading）：409 SESSION_STATE_INVALID", async () => {
    const { email, sessionId } = await newUserWithSession({ state: "reading" });
    const res = await callFeedback(email, sessionId);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SESSION_STATE_INVALID");
  });

  it("限流：懒触发评分属 AI 调用端点，超额返回 429（Prd.md 3.5）", async () => {
    const { email, sessionId } = await newUserWithSession();
    await callFeedback(email, sessionId);
    await waitForScores(sessionId);
    // 已用 1 次额度；剩余 29 次放行，第 31 次拒绝
    for (let i = 0; i < 29; i += 1) {
      const res = await callFeedback(email, sessionId);
      expect(res.status).toBe(200);
    }
    const res = await callFeedback(email, sessionId);
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(json.error.retryAfterSeconds).toBeGreaterThan(0);
  });
});
