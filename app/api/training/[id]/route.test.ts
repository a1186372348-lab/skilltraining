import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";
import { todayUtc } from "@/server/modules/training/service";

import { GET as getToday } from "../today/route";
import { GET } from "./route";

// GET /api/training/[id] 集成测试（T25 / D27）：真实数据库；本端点不触发 AI 调用。
// 单会话工作台载荷：401 / 非法 id / 不存在或他人 404 / baseline kind 拒绝 /
// 正常载荷与 GET /api/training/today 同构（同一视图构建器，FR-10 出口防线不变）。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

const SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000c1";
const BASELINE_KIND_QUESTION_ID = "00000000-0000-4000-8000-0000000000c2";

// 独立种子题 id（与本文件外其他测试文件隔离，避免并发 upsert 互相覆盖）
const SEED_QUESTION_DATA = {
  id: SEED_QUESTION_ID,
  caseTitle: "T25 集成测试种子题",
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
  // draft 状态：本文件用例直接按 questionId 建会话、不经选题引擎；
  // 避免 published 种子题干扰 selection/service 等并行测试文件的选题确定性（共享库竞争，T21 已知）
  status: "draft" as const,
};

async function ensureSeedQuestions(): Promise<void> {
  const { id, ...data } = SEED_QUESTION_DATA;
  try {
    await prisma.question.upsert({ where: { id }, create: SEED_QUESTION_DATA, update: data });
    await prisma.question.upsert({
      where: { id: BASELINE_KIND_QUESTION_ID },
      create: {
        ...SEED_QUESTION_DATA,
        id: BASELINE_KIND_QUESTION_ID,
        caseTitle: "T25 基线题（kind 拒绝验证用）",
        kind: "baseline",
      },
      update: { caseTitle: "T25 基线题（kind 拒绝验证用）", kind: "baseline" },
    });
  } catch {
    // 并发播种冲突：忽略，题目已存在
  }
}

async function buildRequest(id: string, email?: string): Promise<Request> {
  const headers: Record<string, string> = {};
  if (email) {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    headers.cookie = sessionCookieHeader(user);
  }
  return new Request(`http://localhost/api/training/${id}`, { method: "GET", headers });
}

function callRoute(request: Request, id: string) {
  return GET(request, { params: Promise.resolve({ id }) });
}

async function newEmail(): Promise<string> {
  return `t25-session-${randomUUID()}@example.com`;
}

/** 建用户并登记清理 */
async function newUser(): Promise<{ email: string; userId: string }> {
  const email = await newEmail();
  const user = await prisma.user.create({ data: { email } });
  createdUserIds.push(user.id);
  return { email, userId: user.id };
}

/** 基线已完成用户：today 同构用例需对 T17a 基线门禁确定性免疫（同 today 路由测试模式） */
async function newBaselineDoneUser(): Promise<{ email: string; userId: string }> {
  const { email, userId } = await newUser();
  await prisma.userProfile.create({
    data: {
      userId,
      position: "产品经理",
      yearsExperience: "3-5 年",
      industry: "互联网",
      familiarProducts: [],
      interestAreas: [],
      selfAssessment: {},
      baselineCompletedAt: new Date(),
    },
  });
  return { email, userId };
}

async function seedSession(
  userId: string,
  overrides: Partial<{
    questionId: string;
    state: "reading" | "answering" | "followup" | "scored";
    isExtra: boolean;
    hintCount: number;
    firstAnswer: string;
    firstSubmittedAt: Date;
    finalAnswer: string;
    finalSubmittedAt: Date;
    followups: object[];
  }> = {},
) {
  return prisma.trainingSession.create({
    data: {
      userId,
      questionId: overrides.questionId ?? SEED_QUESTION_ID,
      date: todayUtc(),
      isExtra: overrides.isExtra ?? false,
      state: overrides.state ?? "reading",
      hintCount: overrides.hintCount ?? 0,
      firstAnswer: overrides.firstAnswer ?? null,
      firstSubmittedAt: overrides.firstSubmittedAt ?? null,
      finalAnswer: overrides.finalAnswer ?? null,
      finalSubmittedAt: overrides.finalSubmittedAt ?? null,
      followups: overrides.followups ?? undefined,
    },
  });
}

beforeAll(ensureSeedQuestions);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("GET /api/training/[id]：鉴权与归属", () => {
  it("生产环境无会话 cookie：401（T34）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await callRoute(
      await buildRequest("00000000-0000-4000-8000-0000000000ff"),
      "00000000-0000-4000-8000-0000000000ff",
    );
    expect(res.status).toBe(401);
    vi.unstubAllEnvs();
  });

  it("非法会话 id：400 INVALID_SESSION_ID", async () => {
    const { email } = await newUser();
    const res = await callRoute(await buildRequest("not-a-uuid", email), "not-a-uuid");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("INVALID_SESSION_ID");
  });

  it("会话不存在：404 SESSION_NOT_FOUND", async () => {
    const { email } = await newUser();
    const missingId = "00000000-0000-4000-8000-0000000000ee";
    const res = await callRoute(await buildRequest(missingId, email), missingId);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("SESSION_NOT_FOUND");
  });

  it("他人会话：404 SESSION_NOT_FOUND（不泄露存在性）", async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const session = await seedSession(owner.userId);
    const res = await callRoute(await buildRequest(session.id, outsider.email), session.id);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("SESSION_NOT_FOUND");
  });

  it("基线会话（question.kind=baseline）：409 BASELINE_SESSION（前端据此重定向 /baseline）", async () => {
    const { email, userId } = await newUser();
    const session = await seedSession(userId, {
      questionId: BASELINE_KIND_QUESTION_ID,
      isExtra: true, // 基线会话以 isExtra=true 落库（T17a）
    });
    const res = await callRoute(await buildRequest(session.id, email), session.id);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("BASELINE_SESSION");
  });
});

describe("GET /api/training/[id]：工作台载荷", () => {
  it("正常载荷与 GET /api/training/today 同构（同一 today 视图构建器）", async () => {
    const { email, userId } = await newBaselineDoneUser();
    const session = await seedSession(userId, {
      state: "followup",
      hintCount: 1,
      firstAnswer: "我的首次作答",
      firstSubmittedAt: new Date(),
      followups: [
        { round: 1, question: "总监追问内容", hint: "绝密追问提示明文", hintReleased: false },
      ],
    });

    const [byIdJson, todayJson] = await Promise.all([
      callRoute(await buildRequest(session.id, email), session.id).then((res) => res.json()),
      getToday(
        new Request("http://localhost/api/training/today", {
          method: "GET",
          headers: {
            cookie: sessionCookieHeader(
              await prisma.user.findUniqueOrThrow({ where: { email } }),
            ),
          },
        }),
      ).then((res) => res.json()),
    ]);

    expect(byIdJson.success).toBe(true);
    expect(todayJson.success).toBe(true);
    // 该用户当天仅此一个非基线会话：today 与 [id] 命中同一会话
    expect(todayJson.data.sessionId).toBe(session.id);
    expect(byIdJson.data.sessionId).toBe(session.id);
    // 同构：两端点下发完全相同的字段集与关键值
    expect(Object.keys(byIdJson.data).sort()).toEqual(Object.keys(todayJson.data).sort());
    expect(byIdJson.data.state).toBe("followup");
    expect(byIdJson.data.firstAnswer).toBe("我的首次作答");
    expect(byIdJson.data.hintCount).toBe(1);
    expect(byIdJson.data.releasedHints).toHaveLength(1);

    // FR-10 出口防线：Rubric、未释放提示层与未释放追问提示明文绝不下发
    const raw = JSON.stringify(byIdJson);
    expect(raw).not.toContain("绝密要点");
    expect(raw).not.toContain("绝密结论");
    expect(raw).not.toContain("rubric");
    expect(raw).not.toContain("第2层提示");
    expect(raw).not.toContain("绝密追问提示明文");
  });

  it("进行中的旧会话也可取回（历史列表「作答中」点回继续的数据源）", async () => {
    const { email, userId } = await newUser();
    const yesterday = new Date(todayUtc().getTime() - 24 * 60 * 60 * 1000);
    const session = await prisma.trainingSession.create({
      data: {
        userId,
        questionId: SEED_QUESTION_ID,
        date: yesterday,
        state: "answering",
        hintCount: 2,
        startedAt: yesterday,
      },
    });
    const res = await callRoute(await buildRequest(session.id, email), session.id);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.sessionId).toBe(session.id);
    expect(json.data.state).toBe("answering");
    expect(json.data.kind).toBe("daily");
  });
});
