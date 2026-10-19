import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";

import { GET } from "./route";

// T34 隔离性集成测试（红线证据）：两个真实用户各自持有会话 cookie 请求 /api/dashboard，
// 必须各自只看到自己的数据。旧开发态占位实现无视 cookie、一律返回占位账号数据，
// 因此本文件在路由切换前必失败（两账号看到同一份占位数据），切换后通过。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

const SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000a1";

// 与 dashboard/route.test.ts 共用的全量规范种子（同一题目 id，upsert 幂等）。
// 注意：本文件不做「归档其他上架题」——隔离断言（连续天数/已观测维度数）与当前
// 上架题集合无关，归档全局题目会与 selection/service.test.ts 的并发用例互相踩踏
// （其 ensurePublished 防御窗口外的归档会抢走它刚上架的题）。
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
    // 并发播种冲突：忽略，题目已存在
  }
}

/** UTC 零点日期（对齐 training_sessions.date @db.Date） */
function utcDaysAgo(days: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
}

async function createUserWithData(tag: string, streakDays: number, dimensions: string[]) {
  const user = await prisma.user.create({
    data: { email: `t34-isolation-${tag}-${randomUUID()}@example.com` },
  });
  createdUserIds.push(user.id);

  for (let i = 0; i < streakDays; i += 1) {
    const date = utcDaysAgo(i);
    await prisma.trainingSession.create({
      data: {
        userId: user.id,
        questionId: SEED_QUESTION_ID,
        date,
        state: "scored",
        firstAnswer: "首答",
        finalAnswer: "终答",
        firstSubmittedAt: date,
        finalSubmittedAt: date,
        scoredAt: date,
      },
    });
  }
  await prisma.abilityProfile.createMany({
    data: dimensions.map((dimension, index) => ({
      userId: user.id,
      dimension,
      currentScore: 80 - index,
      observationCount: 1,
      trend: "稳定",
    })),
  });
  return user;
}

function authedRequest(user: { id: string; email: string }): Request {
  return new Request("http://localhost/api/dashboard", {
    method: "GET",
    headers: { cookie: sessionCookieHeader(user) },
  });
}

beforeAll(ensureSeedQuestion);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("GET /api/dashboard 会话隔离（T34）", () => {
  it("两个真实用户各自持会话 cookie：各自只看到自己的数据", async () => {
    const userA = await createUserWithData("a", 3, ["用户理解", "产品价值判断"]);
    const userB = await createUserWithData("b", 1, ["产品取舍"]);

    const resA = await GET(authedRequest(userA));
    const viewA = (await resA.json()).data;
    expect(resA.status).toBe(200);
    // A 的数据：连续 3 天、2 个已观测维度
    expect(viewA.stats.streakDays).toBe(3);
    expect(viewA.ability.unlockedCount).toBe(2);

    const resB = await GET(authedRequest(userB));
    const viewB = (await resB.json()).data;
    expect(resB.status).toBe(200);
    // B 的数据：连续 1 天、1 个已观测维度——与 A 互不可见
    expect(viewB.stats.streakDays).toBe(1);
    expect(viewB.ability.unlockedCount).toBe(1);
  });

  it("无会话 cookie：401（不再回退占位账号）", async () => {
    const res = await GET(
      new Request("http://localhost/api/dashboard", { method: "GET" }),
    );
    expect(res.status).toBe(401);
  });
});
