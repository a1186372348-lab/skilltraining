import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";
import { todayUtc } from "@/server/modules/training/service";

import { GET } from "./route";

// GET /api/training/today 集成测试：真实数据库；本端点不触发 AI 调用。

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
    // 共享开发库已导入真实上架题：先下架本种子外的全部上架题，选题结果才确定命中本种子
    await prisma.question.updateMany({
      where: { status: "published", id: { not: id } },
      data: { status: "archived" },
    });
    await prisma.question.upsert({ where: { id }, create: SEED_QUESTION_DATA, update: data });
  } catch {
    // 并发播种冲突：忽略，题目已存在
  }
}

async function buildRequest(email?: string): Promise<Request> {
  const headers: Record<string, string> = {};
  if (email) {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    headers.cookie = sessionCookieHeader(user);
  }
  return new Request("http://localhost/api/training/today", { method: "GET", headers });
}

async function newEmail(): Promise<string> {
  return `t05-today-${randomUUID()}@example.com`;
}

beforeAll(ensureSeedQuestion);

/**
 * T17a 基线门禁是全局状态（并发测试文件可能上架基线题）：
 * 显式预建「已完成基线」的用户，使本文件日常题用例对门禁确定性免疫。
 */
async function newBaselineDoneEmail(): Promise<string> {
  const email = await newEmail();
  const user = await prisma.user.create({ data: { email } });
  createdUserIds.push(user.id);
  await prisma.userProfile.create({
    data: {
      userId: user.id,
      position: "产品经理",
      yearsExperience: "3-5 年",
      industry: "互联网",
      familiarProducts: [],
      interestAreas: [],
      selfAssessment: {},
      baselineCompletedAt: new Date(),
    },
  });
  return email;
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

// ── T21 加练链路：会话选择优先级（真实库） ──────────────────────────

/** 基线题（kind=baseline；draft 双保险不入选题池，仅作会话关联，验证不误返基线会话） */
const BASELINE_KIND_QUESTION_ID = "00000000-0000-4000-8000-0000000000b2";

async function ensureBaselineKindQuestion(): Promise<void> {
  const data = {
    ...SEED_QUESTION_DATA,
    id: BASELINE_KIND_QUESTION_ID,
    caseTitle: "T21 基线题（路由排除验证用）",
    status: "draft" as const,
    kind: "baseline" as const,
  };
  const { id, ...rest } = data;
  try {
    await prisma.question.upsert({ where: { id }, create: data, update: rest });
  } catch {
    // 并发播种冲突：忽略，题目已存在
  }
}

/** 造一个归属于今天的会话（T21 用；startedAt 显式传入保证倒序确定） */
async function seedTodaySession(
  userId: string,
  overrides: Partial<{
    questionId: string;
    isExtra: boolean;
    state: "reading" | "answering" | "followup" | "scored";
    finalAnswer: string;
    finalSubmittedAt: Date;
    startedAt: Date;
  }> = {},
) {
  return prisma.trainingSession.create({
    data: {
      userId,
      questionId: overrides.questionId ?? SEED_QUESTION_ID,
      date: todayUtc(),
      isExtra: overrides.isExtra ?? false,
      state: overrides.state ?? "reading",
      finalAnswer: overrides.finalAnswer ?? null,
      finalSubmittedAt: overrides.finalSubmittedAt ?? null,
      startedAt: overrides.startedAt ?? new Date(),
    },
  });
}

/** 基线已完成的用户（门禁不触发），返回 email 与 userId 供落会话 */
async function newBaselineDoneUser(): Promise<{ email: string; userId: string }> {
  const email = await newBaselineDoneEmail();
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { email, userId: user.id };
}

describe("GET /api/training/today：T21 会话选择（最近非基线会话优先）", () => {
  it("进行中的加练优先于已完成每日一题返回", async () => {
    const { email, userId } = await newBaselineDoneUser();
    await seedTodaySession(userId, {
      state: "followup",
      finalAnswer: "终答",
      finalSubmittedAt: new Date(),
      startedAt: new Date(Date.now() - 3_600_000),
    });
    const extra = await seedTodaySession(userId, { isExtra: true });

    const res = await GET(await buildRequest(email));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.kind).toBe("daily");
    expect(json.data.sessionId).toBe(extra.id);
    expect(json.data.state).toBe("reading");
  });

  it("全部完成：返回最近一个会话（成果卡数据源）", async () => {
    const { email, userId } = await newBaselineDoneUser();
    await seedTodaySession(userId, {
      state: "scored",
      finalAnswer: "每日终答",
      finalSubmittedAt: new Date(),
      startedAt: new Date(Date.now() - 7_200_000),
    });
    const extra = await seedTodaySession(userId, {
      isExtra: true,
      state: "scored",
      finalAnswer: "加练终答",
      finalSubmittedAt: new Date(),
      startedAt: new Date(Date.now() - 3_600_000),
    });

    const json = await (await GET(await buildRequest(email))).json();
    expect(json.data.sessionId).toBe(extra.id);
    expect(json.data.finalAnswer).toBe("加练终答");
  });

  it("基线完成当天落过基线会话（kind=baseline + isExtra）：不误返，照常创建每日一题", async () => {
    await ensureBaselineKindQuestion();
    const { email, userId } = await newBaselineDoneUser();
    const baselineSession = await seedTodaySession(userId, {
      questionId: BASELINE_KIND_QUESTION_ID,
      isExtra: true, // 基线会话以 isExtra=true 落库（T17a）
      state: "scored",
      finalAnswer: "基线终答",
      finalSubmittedAt: new Date(),
    });

    const json = await (await GET(await buildRequest(email))).json();
    expect(json.data.kind).toBe("daily");
    expect(json.data.sessionId).not.toBe(baselineSession.id);
    expect(json.data.caseTitle).toBe("T05 集成测试种子题");
  });
});

describe("GET /api/training/today（US-003 / FR-10）", () => {
  it("首次进入创建会话并返回案例/训练重点/主问题/资料；重复进入复用同一会话", async () => {
    const email = await newBaselineDoneEmail();
    const first = await (await GET(await buildRequest(email))).json();
    const second = await (await GET(await buildRequest(email))).json();

    expect(first.success).toBe(true);
    expect(first.data.sessionId).toBe(second.data.sessionId);
    expect(first.data.state).toBe("reading");
    expect(first.data.kind).toBe("daily");
    expect(first.data.caseTitle).toBe("T05 集成测试种子题");
    expect(first.data.mainQuestion).toBe("测试主问题？");
    expect(first.data.abilityTags).toEqual(["用户理解", "产品价值判断", "产品取舍"]);
    expect(first.data.materials.core).toHaveLength(2);
    expect(first.data.materials.extended).toHaveLength(3);
    expect(first.data.coefficient).toBe(1.0);
    expect(first.data.canRequestHint).toBe(true);
  });

  it("响应绝不含 Rubric 与未释放提示层（FR-10）", async () => {
    const email = await newBaselineDoneEmail();
    const res = await GET(await buildRequest(email));
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain("绝密要点");
    expect(raw).not.toContain("绝密结论");
    expect(raw).not.toContain("rubric");
    expect(raw).not.toContain("第2层提示"); // 未请求提示时一层都不下发
    expect(raw).not.toContain("第1层提示");
  });

  it("生产环境无会话 cookie：401（T34）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(401);
    vi.unstubAllEnvs();
  });
});
