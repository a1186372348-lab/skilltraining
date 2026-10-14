import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";

import { GET } from "./route";

// GET /api/dashboard 集成测试：真实数据库；本端点不触发 AI 调用。

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
  if (!email) {
    return new Request("http://localhost/api/dashboard", { method: "GET" });
  }
  const user = await prisma.user.upsert({ where: { email }, create: { email }, update: {} });
  createdUserIds.push(user.id);
  return new Request("http://localhost/api/dashboard", {
    method: "GET",
    headers: { cookie: sessionCookieHeader(user) },
  });
}

async function newEmail(): Promise<string> {
  return `t08-dashboard-${randomUUID()}@example.com`;
}

/** UTC 零点日期（对齐 training_sessions.date @db.Date） */
function utcDaysAgo(days: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
}

beforeAll(ensureSeedQuestion);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("GET /api/dashboard（US-002）", () => {
  it("新用户全未知：今日任务卡自动就绪，统计/画像/诊断均为空态", async () => {
    const email = await newEmail();
    const res = await GET(await buildRequest(email));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    const view = body.data;

    // 当前训练卡（T26 / D28②）：与大厅同源判定——新用户无任何会话 → 未开始（不再自动建会话，纯读装配）
    expect(view.currentTraining).toEqual({ kind: "not_started", dateKey: view.todayDateKey });

    // 统计条：0 连续、本周 0/7，7 段分段完整且仅今日一段为今天
    expect(view.stats.streakDays).toBe(0);
    expect(view.stats.weekTrainedCount).toBe(0);
    expect(view.stats.weekDays).toHaveLength(7);
    expect(view.stats.weekDays.filter((d: { isToday: boolean }) => d.isToday)).toHaveLength(1);

    // 能力总览：0/8 已解锁，8 个待解锁虚态
    expect(view.ability.unlockedCount).toBe(0);
    expect(view.ability.totalCount).toBe(8);
    expect(view.ability.observed).toEqual([]);
    expect(view.ability.unobserved).toHaveLength(8);

    // 最近诊断：无反馈记录 → 空态
    expect(view.latestDiagnosis).toBeNull();
    expect(view.todayDateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("有历史用户：连续天数、本周进度、能力条形与最近诊断正确装配", async () => {
    const email = await newEmail();
    const user = await prisma.user.create({ data: { email } });
    createdUserIds.push(user.id);

    // 连续 3 天有终答的会话（今天 / 昨天 / 前天）；今天的即今日会话（已评分）
    const dates = [utcDaysAgo(0), utcDaysAgo(1), utcDaysAgo(2)];
    const sessions = await Promise.all(
      dates.map((date) =>
        prisma.trainingSession.create({
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
        }),
      ),
    );
    const todaySession = sessions[0]!;

    // 画像：两个已观测维度（产品价值判断 75.6 > 用户理解 68.4）
    await prisma.abilityProfile.createMany({
      data: [
        { userId: user.id, dimension: "产品价值判断", currentScore: 75.6, observationCount: 4, trend: "上升" },
        { userId: user.id, dimension: "用户理解", currentScore: 68.4, observationCount: 2, trend: "稳定" },
      ],
    });

    // 最近诊断：长文本，验证截断
    const longIssue = "你最近几次训练在论证时缺少数据支撑。".repeat(10);
    await prisma.sessionFeedback.create({
      data: { sessionId: todaySession.id, topIssueText: longIssue, nextFocusText: "下一步" },
    });

    const res = await GET(await buildRequest(email));
    const body = await res.json();
    expect(res.status).toBe(200);
    const view = body.data;

    // 连续 3 天；本周完成数与分段一致，今日段已训练
    expect(view.stats.streakDays).toBe(3);
    expect(view.stats.weekTrainedCount).toBe(
      view.stats.weekDays.filter((d: { trained: boolean }) => d.trained).length,
    );
    expect(view.stats.weekTrainedCount).toBeGreaterThanOrEqual(1);
    expect(view.stats.weekDays.find((d: { isToday: boolean }) => d.isToday).trained).toBe(true);

    // 当前训练卡：今日 daily 已评分 → 已完成（无维度评分行 → 得分摘要为空）
    expect(view.currentTraining).toEqual({
      kind: "completed",
      sessionId: todaySession.id,
      caseTitle: "T05 集成测试种子题",
      scores: [],
    });

    // 能力总览：2/8，按分数降序取整，趋势透传
    expect(view.ability.unlockedCount).toBe(2);
    expect(view.ability.observed.map((o: { dimension: string }) => o.dimension)).toEqual([
      "产品价值判断",
      "用户理解",
    ]);
    expect(view.ability.observed[0].score).toBe(76);
    expect(view.ability.observed[0].trend).toBe("上升");
    expect(view.ability.unobserved).toHaveLength(6);

    // 最近诊断：来自今日会话，长文本截断为 90 字 + 省略号
    expect(view.latestDiagnosis.sessionId).toBe(todaySession.id);
    expect(view.latestDiagnosis.text).toHaveLength(91);
    expect(view.latestDiagnosis.text.endsWith("…")).toBe(true);
    expect(view.latestDiagnosis.dateKey).toBe(view.todayDateKey);
  });

  it("生产环境无会话 cookie：401（安全默认不随环境变化，T34）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(401);
    vi.unstubAllEnvs();
  });
});
