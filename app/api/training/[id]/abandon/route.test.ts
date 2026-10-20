import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";
import { todayUtc } from "@/server/modules/training/service";

import { GET as getToday } from "../../today/route";
import { POST as postExtra } from "../../extra/route";
import { POST } from "./route";

// POST /api/training/[id]/abandon 集成测试（T38 / D40）：真实数据库；本端点不触发 AI 调用。
// 覆盖：401 / 非法 id 400 / 不存在与他人 404 / 基线会话 409 / 已提交终答 409 /
// 已评分 409 / 幂等成功 / 统一限流 429 / 三态成功终止（数据零损失）；
// 以及重启链路：today 与加练的复用查询排除已终止会话（换新题）。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

const SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000e1";
const BASELINE_KIND_QUESTION_ID = "00000000-0000-4000-8000-0000000000e2";
/** 共享上架种子题（与其他路由测试同 id）：重启链路选题的确定性候选 */
const SHARED_PUBLISHED_QUESTION_ID = "00000000-0000-4000-8000-0000000000a1";

// 独立种子题 id（与本文件外其他测试文件隔离，避免并发 upsert 互相覆盖）
const SEED_QUESTION_DATA = {
  id: SEED_QUESTION_ID,
  caseTitle: "T38 集成测试种子题",
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
        caseTitle: "T38 基线题（kind 拒绝验证用）",
        kind: "baseline",
      },
      update: { caseTitle: "T38 基线题（kind 拒绝验证用）", kind: "baseline" },
    });
    // 重启链路选题需要至少一道上架日常题：确保共享种子题处于上架状态
    //（并行测试文件可能归档全部上架题，此处防御性恢复，与 selection 测试的 ensurePublished 同款）
    await prisma.question.updateMany({
      where: { id: SHARED_PUBLISHED_QUESTION_ID },
      data: { status: "published", kind: "daily" },
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
  return new Request(`http://localhost/api/training/${id}/abandon`, { method: "POST", headers });
}

function callRoute(request: Request, id: string) {
  return POST(request, { params: Promise.resolve({ id }) });
}

async function authedGetToday(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return getToday(
    new Request("http://localhost/api/training/today", {
      method: "GET",
      headers: { cookie: sessionCookieHeader(user) },
    }),
  );
}

async function authedPostExtra(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return postExtra(
    new Request("http://localhost/api/training/extra", {
      method: "POST",
      headers: { cookie: sessionCookieHeader(user) },
    }),
  );
}

/** 建用户并登记清理 */
async function newUser(): Promise<{ email: string; userId: string }> {
  const email = `t38-abandon-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email } });
  createdUserIds.push(user.id);
  return { email, userId: user.id };
}

/** 基线已完成用户：today / extra 链路用例需对 T17a 基线门禁确定性免疫（同 today 路由测试模式） */
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
    state: "reading" | "answering" | "followup" | "scored" | "abandoned";
    isExtra: boolean;
    hintCount: number;
    firstAnswer: string | null;
    firstSubmittedAt: Date | null;
    finalAnswer: string | null;
    finalSubmittedAt: Date | null;
    date: Date;
  }> = {},
) {
  return prisma.trainingSession.create({
    data: {
      userId,
      questionId: overrides.questionId ?? SEED_QUESTION_ID,
      date: overrides.date ?? todayUtc(),
      isExtra: overrides.isExtra ?? false,
      state: overrides.state ?? "reading",
      hintCount: overrides.hintCount ?? 0,
      firstAnswer: overrides.firstAnswer ?? null,
      firstSubmittedAt: overrides.firstSubmittedAt ?? null,
      finalAnswer: overrides.finalAnswer ?? null,
      finalSubmittedAt: overrides.finalSubmittedAt ?? null,
    },
  });
}

beforeAll(ensureSeedQuestions);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("POST /api/training/[id]/abandon：鉴权与归属", () => {
  it("生产环境无会话 cookie：401（T34）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const id = "00000000-0000-4000-8000-0000000000ff";
    const res = await callRoute(await buildRequest(id), id);
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
});

describe("POST /api/training/[id]/abandon：终止守卫（D40④）", () => {
  it("基线会话（question.kind=baseline）：409 BASELINE_SESSION（基线题必须完成，D19 门禁不变）", async () => {
    const { email, userId } = await newUser();
    const session = await seedSession(userId, {
      questionId: BASELINE_KIND_QUESTION_ID,
      isExtra: true, // 基线会话以 isExtra=true 落库（T17a）
    });
    const res = await callRoute(await buildRequest(session.id, email), session.id);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("BASELINE_SESSION");
    // 未被终止
    const fresh = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(fresh.state).toBe("reading");
  });

  it("已提交终答待评分（followup + finalSubmittedAt）：409 FINAL_ANSWER_ALREADY_SUBMITTED", async () => {
    const { email, userId } = await newUser();
    const session = await seedSession(userId, {
      state: "followup",
      firstAnswer: "首答",
      firstSubmittedAt: new Date(),
      finalAnswer: "终答",
      finalSubmittedAt: new Date(),
    });
    const res = await callRoute(await buildRequest(session.id, email), session.id);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("FINAL_ANSWER_ALREADY_SUBMITTED");
    const fresh = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(fresh.state).toBe("followup");
  });

  it("已评分会话（scored）：409 SESSION_ALREADY_SCORED", async () => {
    const { email, userId } = await newUser();
    const session = await seedSession(userId, {
      state: "scored",
      firstAnswer: "首答",
      firstSubmittedAt: new Date(),
      finalAnswer: "终答",
      finalSubmittedAt: new Date(),
    });
    const res = await callRoute(await buildRequest(session.id, email), session.id);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("SESSION_ALREADY_SCORED");
  });
});

describe("POST /api/training/[id]/abandon：成功与幂等", () => {
  it("reading / answering / followup（未交终答）均可终止：200 且状态落库 abandoned", async () => {
    for (const state of ["reading", "answering", "followup"] as const) {
      const { email, userId } = await newUser();
      const session = await seedSession(userId, {
        state,
        firstAnswer: state === "followup" ? "首答保留" : null,
        firstSubmittedAt: state === "followup" ? new Date() : null,
      });
      const res = await callRoute(await buildRequest(session.id, email), session.id);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.sessionId).toBe(session.id);
      expect(json.data.state).toBe("abandoned");

      // 终止是状态推进而非删除（D40②）：会话与作答数据零损失
      const fresh = await prisma.trainingSession.findUniqueOrThrow({
        where: { id: session.id },
      });
      expect(fresh.state).toBe("abandoned");
      if (state === "followup") {
        expect(fresh.firstAnswer).toBe("首答保留");
        expect(fresh.firstSubmittedAt).not.toBeNull();
      }
    }
  });

  it("幂等：已 abandoned 会话重复终止返回成功，不报错不改动", async () => {
    const { email, userId } = await newUser();
    const session = await seedSession(userId, { state: "answering" });

    const first = await callRoute(await buildRequest(session.id, email), session.id);
    expect(first.status).toBe(200);
    const second = await callRoute(await buildRequest(session.id, email), session.id);
    expect(second.status).toBe(200);
    const json = await second.json();
    expect(json.success).toBe(true);
    expect(json.data.state).toBe("abandoned");
    expect(await prisma.trainingSession.count({ where: { userId } })).toBe(1);
  });

  it("限流：与既有训练端点同一 AI 端点限流，超额返回 429（Prd.md 3.5）", async () => {
    const { email, userId } = await newUser();
    const session = await seedSession(userId);
    // 幂等复用同一会话，30 次额度内全部放行
    for (let i = 0; i < 30; i += 1) {
      const res = await callRoute(await buildRequest(session.id, email), session.id);
      expect(res.status).toBe(200);
    }
    const res = await callRoute(await buildRequest(session.id, email), session.id);
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(json.error.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("终止后的重启链路（T38 / D40③：复用查询排除已终止会话，重启出新题）", () => {
  it("今日 daily 已终止 → GET /api/training/today 创建新会话（不复用、不换原题）", async () => {
    const { email, userId } = await newBaselineDoneUser();
    const abandoned = await seedSession(userId, { state: "reading" });
    const res = await callRoute(await buildRequest(abandoned.id, email), abandoned.id);
    expect(res.status).toBe(200);

    const todayRes = await authedGetToday(email);
    expect(todayRes.status).toBe(200);
    const json = await todayRes.json();
    // 新会话：不是被终止的那个；选题排除被终止题（有任何会话的题不再选到）
    expect(json.data.sessionId).not.toBe(abandoned.id);
    expect(json.data.kind).toBe("daily");
    const fresh = await prisma.trainingSession.findUniqueOrThrow({
      where: { id: json.data.sessionId },
    });
    expect(fresh.questionId).not.toBe(SEED_QUESTION_ID);
    expect(fresh.state).toBe("reading");
    expect(await prisma.trainingSession.count({ where: { userId } })).toBe(2);
  });

  it("当天同时存在已终止与已评分 daily → today 返回已评分会话（已终止不算「最近会话」）", async () => {
    const { email, userId } = await newBaselineDoneUser();
    const scored = await seedSession(userId, {
      state: "scored",
      firstAnswer: "首答",
      firstSubmittedAt: new Date(),
      finalAnswer: "终答",
      finalSubmittedAt: new Date(),
    });
    // 终止一个更晚开始的会话：排除后最近非终止会话为已评分那条
    const later = await seedSession(userId, { questionId: SEED_QUESTION_ID, isExtra: true });
    await prisma.trainingSession.update({
      where: { id: later.id },
      data: { startedAt: new Date(Date.now() + 1000) },
    });
    const res = await callRoute(await buildRequest(later.id, email), later.id);
    expect(res.status).toBe(200);

    const todayRes = await authedGetToday(email);
    const json = await todayRes.json();
    expect(json.data.sessionId).toBe(scored.id);
    expect(json.data.state).toBe("scored");
  });

  it("加练会话已终止 → POST /api/training/extra 创建新加练（不复用已终止会话）", async () => {
    const { email, userId } = await newBaselineDoneUser();
    const abandonedExtra = await seedSession(userId, {
      state: "answering",
      isExtra: true,
    });
    const res = await callRoute(await buildRequest(abandonedExtra.id, email), abandonedExtra.id);
    expect(res.status).toBe(200);

    const extraRes = await authedPostExtra(email);
    expect(extraRes.status).toBe(200);
    const json = await extraRes.json();
    expect(json.data.sessionId).not.toBe(abandonedExtra.id);
    const fresh = await prisma.trainingSession.findUniqueOrThrow({
      where: { id: json.data.sessionId },
    });
    expect(fresh.isExtra).toBe(true);
    expect(fresh.state).toBe("reading");
    // 选题排除被终止题
    expect(fresh.questionId).not.toBe(SEED_QUESTION_ID);
  });
});
