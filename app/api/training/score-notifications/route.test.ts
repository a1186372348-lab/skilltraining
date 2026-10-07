import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DEV_USER_HEADER } from "@/server/lib/dev-identity";

import { GET } from "./route";

// GET /api/training/score-notifications 集成测试（T24 / Prd.md D26）：真实数据库。
// 覆盖：未登录 401、只返回本人会话、排除 kind=baseline、scored 7 天窗口与上限 5、
// stuck 5 分钟阈值与上限 3、已 scored 不进 stuck、响应契约形状。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

const SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000a1";
const SEED_BASELINE_QUESTION_ID = "00000000-0000-4000-8000-0000000000b2";

// 日常种子题：与 T05 各测试文件共用同一 id，upsert 保证并发播种结果一致
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

async function ensureSeedQuestions(): Promise<void> {
  try {
    const { id, ...data } = SEED_QUESTION_DATA;
    await prisma.question.upsert({ where: { id }, create: SEED_QUESTION_DATA, update: data });
    // 基线种子题：draft 状态不参与选题引擎，避免干扰共享测试库的其他文件
    await prisma.question.upsert({
      where: { id: SEED_BASELINE_QUESTION_ID },
      create: { ...SEED_QUESTION_DATA, id: SEED_BASELINE_QUESTION_ID, kind: "baseline", status: "draft", caseTitle: "T24 基线种子题" },
      update: { ...data, kind: "baseline", status: "draft", caseTitle: "T24 基线种子题" },
    });
  } catch {
    // 并发播种冲突：忽略，题目已存在
  }
}

async function newUser(): Promise<{ email: string; userId: string }> {
  const email = `t24-notify-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email } });
  createdUserIds.push(user.id);
  return { email, userId: user.id };
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

async function createSession(
  userId: string,
  overrides: {
    questionId?: string;
    state?: "reading" | "answering" | "followup" | "scored";
    finalSubmittedAt?: Date | null;
    scoredAt?: Date | null;
  } = {},
): Promise<string> {
  const state = overrides.state ?? "scored";
  const session = await prisma.trainingSession.create({
    data: {
      userId,
      questionId: overrides.questionId ?? SEED_QUESTION_ID,
      date: new Date(Date.UTC(2026, 9, 7)),
      state,
      firstAnswer: "首答",
      firstSubmittedAt: minutesAgo(30),
      finalAnswer: "终答",
      finalSubmittedAt:
        overrides.finalSubmittedAt === undefined ? minutesAgo(10) : overrides.finalSubmittedAt,
      scoredAt: overrides.scoredAt === undefined ? (state === "scored" ? minutesAgo(1) : null) : overrides.scoredAt,
    },
  });
  return session.id;
}

function callNotifications(email?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (email) headers[DEV_USER_HEADER] = email;
  return GET(new Request("http://localhost/api/training/score-notifications", { headers }));
}

beforeAll(ensureSeedQuestions);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("GET /api/training/score-notifications（T24 / D26）", () => {
  it("未登录（生产环境无身份解析）：401 UNAUTHORIZED", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const res = await callNotifications("t24-anon@example.com");
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("UNAUTHORIZED");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("scored：近 7 天已评分会话返回，契约含 sessionId/caseTitle/kind/occurredAt", async () => {
    const { email, userId } = await newUser();
    const sessionId = await createSession(userId);

    const res = await callNotifications(email);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    const hit = json.data.items.find((item: { sessionId: string }) => item.sessionId === sessionId);
    expect(hit).toMatchObject({ sessionId, caseTitle: "T05 集成测试种子题", kind: "scored" });
    expect(typeof hit.occurredAt).toBe("string");
  });

  it("只返回本人会话：他人已评分会话不出现在 items", async () => {
    const mine = await newUser();
    const stranger = await newUser();
    const strangerSession = await createSession(stranger.userId);

    const json = await (await callNotifications(mine.email)).json();
    const ids = json.data.items.map((item: { sessionId: string }) => item.sessionId);
    expect(ids).not.toContain(strangerSession);
  });

  it("排除基线：kind=baseline 的已评分会话不返回（D26⑦）", async () => {
    const { email, userId } = await newUser();
    await createSession(userId, { questionId: SEED_BASELINE_QUESTION_ID });

    const json = await (await callNotifications(email)).json();
    expect(json.data.items).toEqual([]);
  });

  it("scored 窗口：scoredAt 在 7 天前（8 天）的会话不返回", async () => {
    const { email, userId } = await newUser();
    await createSession(userId, { scoredAt: minutesAgo(8 * 24 * 60) });

    const json = await (await callNotifications(email)).json();
    expect(json.data.items).toEqual([]);
  });

  it("stuck：终答提交 6 分钟仍在 followup 的会话返回 kind=stuck", async () => {
    const { email, userId } = await newUser();
    const sessionId = await createSession(userId, {
      state: "followup",
      finalSubmittedAt: minutesAgo(6),
      scoredAt: null,
    });

    const json = await (await callNotifications(email)).json();
    const hit = json.data.items.find((item: { sessionId: string }) => item.sessionId === sessionId);
    expect(hit).toMatchObject({ sessionId, kind: "stuck" });
  });

  it("stuck 阈值：终答提交仅 4 分钟的会话不返回", async () => {
    const { email, userId } = await newUser();
    await createSession(userId, {
      state: "followup",
      finalSubmittedAt: minutesAgo(4),
      scoredAt: null,
    });

    const json = await (await callNotifications(email)).json();
    expect(json.data.items).toEqual([]);
  });

  it("已 scored 会话不进入 stuck（终答再久也只报评分完成）", async () => {
    const { email, userId } = await newUser();
    const sessionId = await createSession(userId, {
      state: "scored",
      finalSubmittedAt: minutesAgo(60),
      scoredAt: minutesAgo(50),
    });

    const json = await (await callNotifications(email)).json();
    const hits = json.data.items.filter(
      (item: { sessionId: string }) => item.sessionId === sessionId,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("scored");
  });

  it("上限与排序：6 个 scored 会话至多返回 5 条且按 scoredAt 倒序", async () => {
    const { email, userId } = await newUser();
    for (let i = 0; i < 6; i += 1) {
      await createSession(userId, { scoredAt: minutesAgo(60 - i) });
    }

    const json = await (await callNotifications(email)).json();
    const scored = json.data.items.filter((item: { kind: string }) => item.kind === "scored");
    expect(scored).toHaveLength(5);
    const occurred = scored.map((item: { occurredAt: string }) => Date.parse(item.occurredAt));
    expect([...occurred].sort((a, b) => b - a)).toEqual(occurred);
  });

  it("上限与排序：4 个 stuck 会话至多返回 3 条且按 finalSubmittedAt 倒序", async () => {
    const { email, userId } = await newUser();
    for (let i = 0; i < 4; i += 1) {
      await createSession(userId, {
        state: "followup",
        finalSubmittedAt: minutesAgo(60 - i * 5),
        scoredAt: null,
      });
    }

    const json = await (await callNotifications(email)).json();
    const stuck = json.data.items.filter((item: { kind: string }) => item.kind === "stuck");
    expect(stuck).toHaveLength(3);
    const occurred = stuck.map((item: { occurredAt: string }) => Date.parse(item.occurredAt));
    expect([...occurred].sort((a, b) => b - a)).toEqual(occurred);
  });

  it("排除基线：kind=baseline 的 stuck 会话不返回（D26⑦）", async () => {
    const { email, userId } = await newUser();
    await createSession(userId, {
      questionId: SEED_BASELINE_QUESTION_ID,
      state: "followup",
      finalSubmittedAt: minutesAgo(30),
      scoredAt: null,
    });

    const json = await (await callNotifications(email)).json();
    expect(json.data.items).toEqual([]);
  });
});
