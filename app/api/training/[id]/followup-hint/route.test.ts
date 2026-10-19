import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";

import { POST } from "./route";

// POST /api/training/:id/followup-hint 集成测试（T19 / D22）：真实数据库；本端点只读库，不触发 AI 调用。

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

/** 造一个 followup 状态、第 1 轮追问带预生成提示的会话 */
async function newUserWithFollowupSession() {
  const email = `t19-followup-hint-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email } });
  createdUserIds.push(user.id);
  const session = await prisma.trainingSession.create({
    data: {
      userId: user.id,
      questionId: SEED_QUESTION_ID,
      date: new Date(Date.UTC(2026, 9, 3)),
      state: "followup",
      hintCount: 1,
      firstAnswer: "首答",
      firstSubmittedAt: new Date(),
      followups: [{ round: 1, question: "追问一", hint: "追问提示一", hintReleased: false }],
    },
  });
  return { email, sessionId: session.id };
}

async function callFollowupHint(email: string, sessionId: string, body: unknown = { round: 1 }) {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email },
    update: {},
  });
  createdUserIds.push(user.id);
  const request = new Request("http://localhost/api/training/x/followup-hint", {
    method: "POST",
    headers: { cookie: sessionCookieHeader(user), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id: sessionId }) });
}

beforeAll(ensureSeedQuestion);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("POST /api/training/:id/followup-hint（T19 / D22 / BR-2 修订）", () => {
  it("释放该轮预生成提示：返回 hint、followupHintCount 与组合系数", async () => {
    const { email, sessionId } = await newUserWithFollowupSession();
    const res = await callFollowupHint(email, sessionId);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      round: 1,
      hint: "追问提示一",
      followupHintCount: 1,
      coefficient: 0.85, // hint=1 + followupHint=1
    });
  });

  it("幂等：同一 round 重复请求返回已释放 hint，不重复计数", async () => {
    const { email, sessionId } = await newUserWithFollowupSession();
    const first = await callFollowupHint(email, sessionId);
    const second = await callFollowupHint(email, sessionId);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const json = await second.json();
    expect(json.data.hint).toBe("追问提示一");
    expect(json.data.followupHintCount).toBe(1);
    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.followupHintCount).toBe(1);
  });

  it("会话 id 非 uuid：400", async () => {
    const { email } = await newUserWithFollowupSession();
    const res = await callFollowupHint(email, "not-a-uuid");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_SESSION_ID");
  });

  it("入参校验：缺 round / round 非正整数 → 400", async () => {
    const { email, sessionId } = await newUserWithFollowupSession();
    for (const body of [{}, { round: 0 }, { round: 1.5 }, { round: "1" }]) {
      const res = await callFollowupHint(email, sessionId, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("他人会话：404（不泄露存在性）", async () => {
    const { sessionId } = await newUserWithFollowupSession();
    const stranger = `t19-followup-hint-stranger-${randomUUID()}@example.com`;
    const res = await callFollowupHint(stranger, sessionId);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SESSION_NOT_FOUND");
  });

  it("越状态：首答未提交（reading）409 拒绝", async () => {
    const email = `t19-followup-hint-${randomUUID()}@example.com`;
    const user = await prisma.user.create({ data: { email } });
    createdUserIds.push(user.id);
    const session = await prisma.trainingSession.create({
      data: {
        userId: user.id,
        questionId: SEED_QUESTION_ID,
        date: new Date(Date.UTC(2026, 9, 3)),
        state: "reading",
      },
    });
    const res = await callFollowupHint(email, session.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("INVALID_STATE");
  });
});
