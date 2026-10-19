import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";
import { todayUtc } from "@/server/modules/training/service";

import { GET } from "./route";

// GET /api/training/hub 集成测试（T25 / D27）：真实数据库；本端点不触发 AI 调用。
// 大厅载荷：当前卡三态（含阶段映射与优先级）、历史列表（基线排除、徽章字段、
// 倒序与 20 条上限）、连续训练天数、空大厅（新用户）、401。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

const SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000d1";
const BASELINE_KIND_QUESTION_ID = "00000000-0000-4000-8000-0000000000d2";

const SEED_QUESTION_DATA = {
  id: SEED_QUESTION_ID,
  caseTitle: "T25 大厅集成测试种子题",
  caseBackground: { product: "测试产品", audience: "测试用户", scenario: "测试场景" },
  mainQuestion: "测试主问题？",
  abilityTags: ["用户理解", "根因分析"],
  difficulty: 2,
  rubric: { dimensions: {}, forbidden_leaks: [] },
  hintTree: [1, 2, 3, 4, 5].map((level) => ({
    level,
    stage: `阶段${level}`,
    question: `第${level}层提示`,
  })),
  materials: { core: [], extended: [] },
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
        caseTitle: "T25 大厅基线题（排除验证用）",
        kind: "baseline",
      },
      update: { caseTitle: "T25 大厅基线题（排除验证用）", kind: "baseline" },
    });
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
  return new Request("http://localhost/api/training/hub", { method: "GET", headers });
}

async function newUser(): Promise<{ email: string; userId: string }> {
  const email = `t25-hub-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email } });
  createdUserIds.push(user.id);
  return { email, userId: user.id };
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedSession(
  userId: string,
  overrides: Partial<{
    questionId: string;
    date: Date;
    startedAt: Date;
    state: "reading" | "answering" | "followup" | "scored";
    isExtra: boolean;
    finalAnswer: string;
    finalSubmittedAt: Date;
  }> = {},
) {
  return prisma.trainingSession.create({
    data: {
      userId,
      questionId: overrides.questionId ?? SEED_QUESTION_ID,
      date: overrides.date ?? todayUtc(),
      startedAt: overrides.startedAt ?? new Date(),
      state: overrides.state ?? "reading",
      isExtra: overrides.isExtra ?? false,
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

describe("GET /api/training/hub：鉴权", () => {
  it("生产环境无会话 cookie：401（T34）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(401);
    vi.unstubAllEnvs();
  });
});

describe("GET /api/training/hub：空大厅（新用户）", () => {
  it("当前卡「未开始」（携带今日日期键）、历史为空、连续 0 天", async () => {
    const { email } = await newUser();
    const json = await (await GET(await buildRequest(email))).json();
    expect(json.success).toBe(true);
    expect(json.data.current).toEqual({
      kind: "not_started",
      dateKey: todayUtc().toISOString().slice(0, 10),
    });
    expect(json.data.history).toEqual([]);
    expect(json.data.streakDays).toBe(0);
  });
});

describe("GET /api/training/hub：当前训练卡三态", () => {
  it("进行中阶段映射：reading→作答中 / followup 未交终答→追问中 / 已交终答→评分中", async () => {
    const reading = await newUser();
    await seedSession(reading.userId, { state: "reading" });
    const followup = await newUser();
    await seedSession(followup.userId, { state: "followup" });
    const scoring = await newUser();
    await seedSession(scoring.userId, {
      state: "followup",
      finalAnswer: "终答",
      finalSubmittedAt: new Date(),
    });

    const [readingJson, followupJson, scoringJson] = await Promise.all([
      GET(await buildRequest(reading.email)).then((res) => res.json()),
      GET(await buildRequest(followup.email)).then((res) => res.json()),
      GET(await buildRequest(scoring.email)).then((res) => res.json()),
    ]);
    expect(readingJson.data.current).toMatchObject({ kind: "in_progress", stage: "answering" });
    expect(followupJson.data.current).toMatchObject({ kind: "in_progress", stage: "followup" });
    expect(scoringJson.data.current).toMatchObject({ kind: "in_progress", stage: "scoring" });
  });

  it("优先级：今日 daily 已评分 + 昨日未完成会话 → 仍是「进行中」（取最新未完成）", async () => {
    const { email, userId } = await newUser();
    await seedSession(userId, {
      state: "scored",
      finalAnswer: "今日终答",
      finalSubmittedAt: new Date(),
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const stale = await seedSession(userId, {
      date: new Date(todayUtc().getTime() - DAY_MS),
      startedAt: new Date(Date.now() - DAY_MS),
      state: "answering",
    });
    const json = await (await GET(await buildRequest(email))).json();
    expect(json.data.current).toMatchObject({
      kind: "in_progress",
      sessionId: stale.id,
      stage: "answering",
    });
  });

  it("今日 daily 已评分（且无未完成）→「已完成」：附 ≤3 条维度有效分摘要", async () => {
    const { email, userId } = await newUser();
    const session = await seedSession(userId, {
      state: "scored",
      finalAnswer: "终答",
      finalSubmittedAt: new Date(),
    });
    await prisma.score.createMany({
      data: ["用户理解", "根因分析", "指标与验证", "产品取舍"].map((dimension, index) => ({
        sessionId: session.id,
        dimension,
        rawScore: 80 - index * 10,
        hintCount: 0,
        coefficient: 1,
        effectiveScore: 80 - index * 10,
      })),
    });
    const json = await (await GET(await buildRequest(email))).json();
    expect(json.data.current.kind).toBe("completed");
    expect(json.data.current.sessionId).toBe(session.id);
    expect(json.data.current.caseTitle).toBe("T25 大厅集成测试种子题");
    expect(json.data.current.scores).toHaveLength(3);
    expect(json.data.current.scores[0]).toMatchObject({ dimension: "用户理解" });
  });
});

describe("GET /api/training/hub：历史列表", () => {
  it("基线会话（kind=baseline）不进历史、不触发进行中", async () => {
    const { email, userId } = await newUser();
    const baseline = await seedSession(userId, {
      questionId: BASELINE_KIND_QUESTION_ID,
      isExtra: true, // 基线会话以 isExtra=true 落库（T17a）
      state: "answering",
    });
    const daily = await seedSession(userId, { state: "answering" });
    const json = await (await GET(await buildRequest(email))).json();
    // 进行中的基线会话不算「当前训练」的进行中——daily 会话才是
    expect(json.data.current).toMatchObject({ kind: "in_progress", sessionId: daily.id });
    const historyIds = json.data.history.map((row: { sessionId: string }) => row.sessionId);
    expect(historyIds).toContain(daily.id);
    expect(historyIds).not.toContain(baseline.id);
  });

  it("仅基线会话的用户：当前卡「未开始」、历史为空（基线不进大厅，D26⑦/D27 同口径）", async () => {
    const { email, userId } = await newUser();
    await seedSession(userId, {
      questionId: BASELINE_KIND_QUESTION_ID,
      isExtra: true,
      state: "answering",
    });
    const json = await (await GET(await buildRequest(email))).json();
    expect(json.data.current.kind).toBe("not_started");
    expect(json.data.history).toEqual([]);
  });

  it("每日/加练徽章字段、能力标签、startedAt 倒序", async () => {
    const { email, userId } = await newUser();
    const older = await seedSession(userId, {
      state: "scored",
      finalAnswer: "终答",
      finalSubmittedAt: new Date(),
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
    const newer = await seedSession(userId, { isExtra: true, state: "answering" });
    const json = await (await GET(await buildRequest(email))).json();
    expect(json.data.history.map((row: { sessionId: string }) => row.sessionId)).toEqual([
      newer.id,
      older.id,
    ]);
    const [extraRow, dailyRow] = json.data.history;
    expect(extraRow.isExtra).toBe(true);
    expect(dailyRow.isExtra).toBe(false);
    expect(extraRow.abilityTags).toEqual(["用户理解", "根因分析"]);
    expect(typeof extraRow.startedAt).toBe("string");
  });

  it("历史上限 20 条（首版固定条数，分页留空）", async () => {
    const { email, userId } = await newUser();
    await prisma.trainingSession.createMany({
      data: Array.from({ length: 21 }, (_, index) => ({
        userId,
        questionId: SEED_QUESTION_ID,
        date: todayUtc(),
        state: "scored" as const,
        finalAnswer: "终答",
        finalSubmittedAt: new Date(Date.now() - 1000 * (21 - index)),
        startedAt: new Date(Date.now() - 1000 * (21 - index)),
      })),
    });
    const json = await (await GET(await buildRequest(email))).json();
    expect(json.data.history).toHaveLength(20);
  });
});

describe("GET /api/training/hub：连续训练天数", () => {
  it("今天与昨天均有终答 → 连续 2 天；昨天缺席 → 只计今天 1 天", async () => {
    const streakTwo = await newUser();
    await seedSession(streakTwo.userId, {
      state: "scored",
      finalAnswer: "今日终答",
      finalSubmittedAt: new Date(),
    });
    await seedSession(streakTwo.userId, {
      date: new Date(todayUtc().getTime() - DAY_MS),
      startedAt: new Date(Date.now() - DAY_MS),
      state: "scored",
      finalAnswer: "昨日终答",
      finalSubmittedAt: new Date(Date.now() - DAY_MS),
    });

    const streakOne = await newUser();
    await seedSession(streakOne.userId, {
      state: "scored",
      finalAnswer: "今日终答",
      finalSubmittedAt: new Date(),
    });
    await seedSession(streakOne.userId, {
      date: new Date(todayUtc().getTime() - 2 * DAY_MS),
      startedAt: new Date(Date.now() - 2 * DAY_MS),
      state: "scored",
      finalAnswer: "前日终答",
      finalSubmittedAt: new Date(Date.now() - 2 * DAY_MS),
    });

    const [twoJson, oneJson] = await Promise.all([
      GET(await buildRequest(streakTwo.email)).then((res) => res.json()),
      GET(await buildRequest(streakOne.email)).then((res) => res.json()),
    ]);
    expect(twoJson.data.streakDays).toBe(2);
    expect(oneJson.data.streakDays).toBe(1);
  });
});
