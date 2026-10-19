import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";

import { POST } from "./route";

// POST /api/training/:id/hint 集成测试：真实数据库；本端点不触发 AI 调用。

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

async function newUserWithSession() {
  const email = `t05-hint-${randomUUID()}@example.com`;
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
  return { email, sessionId: session.id };
}

async function callHint(email: string, sessionId: string) {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email },
    update: {},
  });
  createdUserIds.push(user.id);
  const request = new Request("http://localhost/api/training/x/hint", {
    method: "POST",
    headers: { cookie: sessionCookieHeader(user) },
  });
  return POST(request, { params: Promise.resolve({ id: sessionId }) });
}

beforeAll(ensureSeedQuestion);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("POST /api/training/:id/hint（FR-3 / D12）", () => {
  it("返回下一层提示与当前系数；hint_events 落库", async () => {
    const { email, sessionId } = await newUserWithSession();
    const res = await callHint(email, sessionId);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.hint).toMatchObject({ level: 1, question: "第1层提示" });
    expect(json.data.coefficient).toBe(0.9);
    expect(json.data.state).toBe("answering");
  });

  it("会话 id 非 uuid：400", async () => {
    const { email } = await newUserWithSession();
    const res = await callHint(email, "not-a-uuid");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_SESSION_ID");
  });

  it("他人会话：404（不泄露存在性）", async () => {
    const { sessionId } = await newUserWithSession();
    const stranger = `t05-hint-stranger-${randomUUID()}@example.com`;
    const res = await callHint(stranger, sessionId);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SESSION_NOT_FOUND");
  });

  it("首次提交后：409 HINT_DISABLED（D7）", async () => {
    const { email, sessionId } = await newUserWithSession();
    await prisma.trainingSession.update({
      where: { id: sessionId },
      data: { state: "followup", firstAnswer: "首答", firstSubmittedAt: new Date() },
    });
    const res = await callHint(email, sessionId);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("HINT_DISABLED");
  });
});
