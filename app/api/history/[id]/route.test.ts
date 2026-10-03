import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DEV_USER_HEADER } from "@/server/lib/dev-identity";

import { GET } from "./route";

// GET /api/history/[id] 集成测试（T10 / US-009 / FR-9）：真实数据库。
// 覆盖：回放装配完整性（案例/首答/提示层数+时间/追问/终答/评分四元组/反馈）、
// 缺失字段标记而非报错、他人记录 404、参数校验、FR-10 出口防线。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

// 独立种子题 id（与 T05 及其他测试文件的种子题隔离，避免并发 upsert 互相覆盖）
const SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000b2";

async function ensureSeedQuestion(): Promise<void> {
  const data = {
    caseTitle: "T10 详情路由种子题",
    caseBackground: {
      product: "测试产品",
      audience: "测试用户",
      scenario: "测试场景",
      related_features: "测试功能",
      current_status: "测试状态",
    },
    mainQuestion: "测试主问题？",
    abilityTags: ["用户理解", "产品价值判断"],
    difficulty: 3,
    rubric: { dimensions: {}, forbidden_leaks: ["绝密结论"] },
    hintTree: [1, 2, 3, 4, 5].map((level) => ({
      level,
      stage: `阶段${level}`,
      question: `第${level}层提示`,
    })),
    materials: { core: [], extended: [] },
    status: "published" as const,
  };
  try {
    await prisma.question.upsert({
      where: { id: SEED_QUESTION_ID },
      create: { id: SEED_QUESTION_ID, ...data },
      update: data,
    });
  } catch {
    // 并发播种冲突：忽略
  }
}

async function newUser(prefix: string) {
  const user = await prisma.user.create({
    data: { email: `${prefix}-${randomUUID()}@example.com` },
  });
  createdUserIds.push(user.id);
  return user;
}

function callDetail(email: string, sessionId: string) {
  const request = new Request(`http://localhost/api/history/${sessionId}`, {
    headers: { [DEV_USER_HEADER]: email },
  });
  return GET(request, { params: Promise.resolve({ id: sessionId }) });
}

/** 造一条走完闭环的会话：提示 2 层 + 追问 2 轮 + 评分 + 反馈 */
async function newScoredSession(userId: string) {
  const session = await prisma.trainingSession.create({
    data: {
      userId,
      questionId: SEED_QUESTION_ID,
      date: new Date(Date.UTC(2026, 9, 3)),
      state: "scored",
      hintCount: 2,
      firstAnswer: "首答：这是质变。",
      firstSubmittedAt: new Date(Date.UTC(2026, 9, 3, 6, 10)),
      finalAnswer: "终答：补充了代价与验证。",
      finalSubmittedAt: new Date(Date.UTC(2026, 9, 3, 6, 40)),
      followups: [
        { round: 1, question: "错误风险下结论还成立吗？" },
        { round: 2, question: "你会看哪个指标？" },
      ],
    },
  });
  await prisma.hintEvent.createMany({
    data: [
      { sessionId: session.id, layer: 1, requestedAt: new Date(Date.UTC(2026, 9, 3, 6, 1)) },
      { sessionId: session.id, layer: 2, requestedAt: new Date(Date.UTC(2026, 9, 3, 6, 5)) },
    ],
  });
  await prisma.score.create({
    data: {
      sessionId: session.id,
      dimension: "用户理解",
      rawScore: 85,
      hintCount: 2,
      coefficient: 0.8,
      effectiveScore: 68,
      diagnosisText: "拆解到位。",
    },
  });
  await prisma.sessionFeedback.create({
    data: {
      sessionId: session.id,
      topIssueText: "终答缺少量化指标。",
      nextFocusText: "下一步练价值量化类问题。",
    },
  });
  return session;
}

beforeAll(ensureSeedQuestion);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("GET /api/history/:id（详情回放）", () => {
  it("完整回放：案例/两版答案/提示层数+时间/追问/评分四元组/反馈一次装配", async () => {
    const user = await newUser("t10-detail-full");
    const session = await newScoredSession(user.id);

    const res = await callDetail(user.email, session.id);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    const view = json.data;

    // 案例区
    expect(view.sessionId).toBe(session.id);
    expect(view.date).toBe("2026-10-03");
    expect(view.caseTitle).toBe("T10 详情路由种子题");
    expect(view.mainQuestion).toBe("测试主问题？");
    expect(view.abilityTags).toEqual(["用户理解", "产品价值判断"]);
    expect(view.difficulty).toBe(3);
    expect(view.caseBackground).toMatchObject({ product: "测试产品" });

    // 两版答案
    expect(view.firstAnswer).toContain("首答");
    expect(view.firstSubmittedAt).toBe("2026-10-03T06:10:00.000Z");
    expect(view.finalAnswer).toContain("终答");
    expect(view.finalSubmittedAt).toBe("2026-10-03T06:40:00.000Z");

    // 提示使用（层数 + 时间）
    expect(view.hintCount).toBe(2);
    expect(view.hintEvents).toEqual([
      { layer: 1, requestedAt: "2026-10-03T06:01:00.000Z" },
      { layer: 2, requestedAt: "2026-10-03T06:05:00.000Z" },
    ]);

    // 追问对话记录
    expect(view.followups).toEqual([
      { round: 1, question: "错误风险下结论还成立吗？" },
      { round: 2, question: "你会看哪个指标？" },
    ]);

    // 评分四元组（D8）
    expect(view.scores).toEqual([
      {
        dimension: "用户理解",
        rawScore: 85,
        hintCount: 2,
        coefficient: 0.8,
        effectiveScore: 68,
        diagnosisText: "拆解到位。",
      },
    ]);

    // 反馈（BR-7）
    expect(view.feedback).toEqual({
      topIssueText: "终答缺少量化指标。",
      nextFocusText: "下一步练价值量化类问题。",
    });

    expect(view.missing).toEqual([]);
    expect(view.state).toBe("scored");
  });

  it("缺失字段标记：已评分但无反馈 → 200 且 missing 含 feedback，不整页报错", async () => {
    const user = await newUser("t10-detail-missing");
    const session = await prisma.trainingSession.create({
      data: {
        userId: user.id,
        questionId: SEED_QUESTION_ID,
        date: new Date(Date.UTC(2026, 9, 3)),
        state: "scored",
        firstAnswer: "首答",
        firstSubmittedAt: new Date(),
        finalAnswer: "终答",
        finalSubmittedAt: new Date(),
      },
    });

    const res = await callDetail(user.email, session.id);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.missing).toEqual(["scores", "feedback"]);
    expect(json.data.scores).toEqual([]);
    expect(json.data.feedback).toBeNull();
    // 其余分区照常装配
    expect(json.data.firstAnswer).toBe("首答");
    expect(json.data.caseTitle).toBe("T10 详情路由种子题");
  });

  it("权限：他人记录返回 404 SESSION_NOT_FOUND（不泄露存在性）", async () => {
    const owner = await newUser("t10-detail-owner");
    const stranger = await newUser("t10-detail-stranger");
    const session = await newScoredSession(owner.id);

    const res = await callDetail(stranger.email, session.id);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SESSION_NOT_FOUND");
  });

  it("不存在的会话：404 SESSION_NOT_FOUND", async () => {
    const user = await newUser("t10-detail-404");
    const res = await callDetail(user.email, randomUUID());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SESSION_NOT_FOUND");
  });

  it("会话 id 非 uuid：400 INVALID_SESSION_ID", async () => {
    const user = await newUser("t10-detail-bad-id");
    const res = await callDetail(user.email, "not-a-uuid");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_SESSION_ID");
  });

  it("未登录（生产环境无身份解析）：401 UNAUTHORIZED", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const res = await callDetail("t10-detail-anon@example.com", randomUUID());
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("UNAUTHORIZED");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("FR-10：详情响应不泄露 rubric / hintTree / 未释放提示内容", async () => {
    const user = await newUser("t10-detail-fr10");
    const session = await newScoredSession(user.id);
    const res = await callDetail(user.email, session.id);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("rubric");
    expect(body).not.toContain("hintTree");
    expect(body).not.toContain("绝密");
    // 提示只回放层数与时间，不下发提示文案
    expect(body).not.toContain("层提示");
  });
});
