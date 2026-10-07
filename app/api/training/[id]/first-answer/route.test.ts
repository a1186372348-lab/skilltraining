import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DEV_USER_HEADER } from "@/server/lib/dev-identity";

import { POST } from "./route";

// POST /api/training/:id/first-answer 集成测试：真实数据库；
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

async function newUserWithSession(overrides?: { firstSubmitted?: boolean }) {
  const email = `t05-first-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email } });
  createdUserIds.push(user.id);
  const session = await prisma.trainingSession.create({
    data: {
      userId: user.id,
      questionId: SEED_QUESTION_ID,
      date: new Date(Date.UTC(2026, 9, 3)),
      state: overrides?.firstSubmitted ? "followup" : "reading",
      firstAnswer: overrides?.firstSubmitted ? "已存在的首答" : null,
      firstSubmittedAt: overrides?.firstSubmitted ? new Date() : null,
      followups: overrides?.firstSubmitted ? [{ round: 1, question: "旧追问" }] : undefined,
    },
  });
  return { email, sessionId: session.id };
}

function callFirstAnswer(email: string, sessionId: string, body: unknown) {
  const request = new Request(`http://localhost/api/training/${sessionId}/first-answer`, {
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

describe("POST /api/training/:id/first-answer（FR-4 / BR-4）", () => {
  it("合法提交：200，状态 followup，追问 1~2 轮返回并落库", async () => {
    const { email, sessionId } = await newUserWithSession();
    const res = await callFirstAnswer(email, sessionId, { answer: "我的首次答案" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.state).toBe("followup");
    // 响应为视图形态：未释放的提示不下发明文（FR-10 / D22）
    expect(json.data.followups).toEqual([
      { round: 1, question: "证据是什么？", hasHint: true, hintReleased: false, hint: null },
      { round: 2, question: "反方如何反驳？", hasHint: true, hintReleased: false, hint: null },
    ]);

    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.state).toBe("followup");
    // 预生成提示随追问落库（D22：点击读库零等待）
    expect(row.followups).toEqual([
      { round: 1, question: "证据是什么？", hint: "想想可衡量的指标", hintReleased: false },
      { round: 2, question: "反方如何反驳？", hint: "站在反方立场找论据", hintReleased: false },
    ]);
  });

  it("空答案：400 VALIDATION_FAILED", async () => {
    const { email, sessionId } = await newUserWithSession();
    const res = await callFirstAnswer(email, sessionId, { answer: "   " });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("会话 id 非 uuid：400", async () => {
    const { email } = await newUserWithSession();
    const res = await callFirstAnswer(email, "not-a-uuid", { answer: "答案" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_SESSION_ID");
  });

  it("不存在的会话：404 SESSION_NOT_FOUND", async () => {
    const { email } = await newUserWithSession();
    const res = await callFirstAnswer(email, randomUUID(), { answer: "答案" });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SESSION_NOT_FOUND");
  });

  it("请求体不是合法 JSON：400 INVALID_JSON", async () => {
    const { email, sessionId } = await newUserWithSession();
    const request = new Request(`http://localhost/api/training/${sessionId}/first-answer`, {
      method: "POST",
      headers: { "content-type": "application/json", [DEV_USER_HEADER]: email },
      body: "{oops",
    });
    const res = await POST(request, { params: Promise.resolve({ id: sessionId }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_JSON");
  });

  it("幂等：重复提交返回既有追问，不覆盖首答", async () => {
    const { email, sessionId } = await newUserWithSession({ firstSubmitted: true });
    generateFollowupsMock.mockClear();
    const res = await callFirstAnswer(email, sessionId, { answer: "试图篡改" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.followups).toEqual([
      // 存量无 hint 老记录：按无提示容错返回，不重复调 AI
      { round: 1, question: "旧追问", hasHint: false, hintReleased: false, hint: null },
    ]);
    expect(generateFollowupsMock).not.toHaveBeenCalled();
    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.firstAnswer).toBe("已存在的首答");
  });
});
