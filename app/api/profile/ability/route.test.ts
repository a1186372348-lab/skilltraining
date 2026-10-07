import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { DEV_USER_HEADER } from "@/server/lib/dev-identity";
import { refreshAbilityProfile } from "@/server/modules/profile/ability";
import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";

import { GET } from "./route";

// 集成测试：直接调用路由处理函数，打真实数据库（docker PostgreSQL:5433）。
// 画像数据经 refreshAbilityProfile 真实管线生成（scores → ability_profiles），
// 身份走开发态 header 透传（T03 登录就绪前的占位，见 server/lib/dev-identity.ts）。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

const SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000a9";

async function ensureSeedQuestion(): Promise<void> {
  const data = {
    caseTitle: "T09 集成测试种子题",
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
  try {
    await prisma.question.upsert({
      where: { id: SEED_QUESTION_ID },
      create: { id: SEED_QUESTION_ID, ...data },
      update: data,
    });
  } catch {
    // 并发测试文件同时播种：冲突时忽略
  }
}

async function newUser(): Promise<{ id: string; email: string }> {
  const email = `t09-api-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email } });
  createdUserIds.push(user.id);
  return { id: user.id, email };
}

/** 直接写一条有效评分（构造画像数据源，绕过评分主链路），返回会话 id 供断言 */
async function seedScore(
  userId: string,
  dimension: string,
  effectiveScore: number,
  hintCount: number,
  scoredAt: Date,
  diagnosisText: string | null = "诊断",
): Promise<string> {
  const session = await prisma.trainingSession.create({
    data: {
      userId,
      questionId: SEED_QUESTION_ID,
      date: scoredAt,
      state: "scored",
      firstAnswer: "首答",
      firstSubmittedAt: scoredAt,
      finalAnswer: "终答",
      finalSubmittedAt: scoredAt,
      scoredAt,
    },
  });
  await prisma.score.create({
    data: {
      sessionId: session.id,
      dimension,
      rawScore: effectiveScore,
      hintCount,
      coefficient: 1.0,
      effectiveScore,
      diagnosisText,
    },
  });
  return session.id;
}

function buildRequest(email: string): Request {
  return new Request("http://localhost/api/profile/ability", {
    method: "GET",
    headers: { [DEV_USER_HEADER]: email },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("GET /api/profile/ability：能力画像页视图（US-008 / FR-8）", () => {
  it("从未训练的用户：8 维全部未知态 + 0/8 洞察 + 探索期方向 + 无整体依赖度", async () => {
    const { email } = await newUser();

    const res = await GET(buildRequest(email));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.insight.observedCount).toBe(0);
    expect(json.data.insight.totalCount).toBe(8);
    expect(json.data.insight.nextFocus).toEqual({
      dimension: "问题定义",
      mode: "explore",
      text: "下一题将优先探索「问题定义」",
    });
    expect(json.data.hintDependencyOverall).toBeNull();
    expect(json.data.dimensions.map((d: { dimension: string }) => d.dimension)).toEqual([
      ...ABILITY_DIMENSIONS,
    ]);
    for (const dim of json.data.dimensions) {
      expect(dim).toMatchObject({
        observed: false,
        currentScore: null,
        observationCount: 0,
        hintDependency: null,
        hintDependencyBand: null,
        trend: null,
        statusLabel: null,
        sparkline: [],
        updatedAt: null,
        recentEvaluations: [],
        recentScores: [],
      });
    }
  });

  it("部分观测：已观测维度带分数/次数/标签/火花线，未观测保持未知，洞察 n/8", async () => {
    const { id: userId, email } = await newUser();
    await ensureSeedQuestion();
    const day = (d: number) => new Date(Date.UTC(2026, 9, d));

    // 用户理解：4 次观测，分数走高 → 趋势上升、样本充足
    await seedScore(userId, "用户理解", 60, 0, day(1));
    await refreshAbilityProfile(prisma, userId, ["用户理解"]);
    await seedScore(userId, "用户理解", 70, 1, day(2));
    await seedScore(userId, "用户理解", 80, 1, day(3));
    const latestSessionId = await seedScore(userId, "用户理解", 90, 2, day(4), "最近一次诊断原文");
    await refreshAbilityProfile(prisma, userId, ["用户理解"]);

    // 产品取舍：2 次观测 → 样本较少
    await seedScore(userId, "产品取舍", 55, 3, day(2));
    await seedScore(userId, "产品取舍", 65, 3, day(3));
    await refreshAbilityProfile(prisma, userId, ["产品取舍"]);

    const res = await GET(buildRequest(email));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    expect(json.data.insight.observedCount).toBe(2);
    // 维度序上第一个未观测维度是问题定义
    expect(json.data.insight.nextFocus).toEqual({
      dimension: "问题定义",
      mode: "explore",
      text: "下一题将优先探索「问题定义」",
    });

    const comprehension = json.data.dimensions.find(
      (d: { dimension: string }) => d.dimension === "用户理解",
    );
    expect(comprehension).toMatchObject({
      observed: true,
      currentScore: 75, // (60+70+80+90)/4
      observationCount: 4,
      trend: "上升",
      statusLabel: "↑ 上升中",
      hintDependencyBand: "中", // (0+1+1+2)/4 = 1
    });
    // 火花线时间升序，取最近若干次有效分
    expect(comprehension.sparkline).toEqual([60, 70, 80, 90]);
    // T16：recentScores 与火花线同口径（近 N 次有效分，时间升序），供 3D 网络图弹窗趋势
    expect(comprehension.recentScores).toEqual([60, 70, 80, 90]);
    // T18：recentEvaluations = 该维度最近评分记录列表（时间倒序），含 sessionId/有效分/日期/案例标题
    expect(comprehension.recentEvaluations).toHaveLength(4);
    expect(comprehension.recentEvaluations[0]).toEqual({
      sessionId: latestSessionId,
      score: 90,
      scoredAt: day(4).toISOString(),
      caseTitle: "T09 集成测试种子题",
    });
    expect(
      comprehension.recentEvaluations.map((e: { score: number }) => e.score),
    ).toEqual([90, 80, 70, 60]);

    const tradeoff = json.data.dimensions.find(
      (d: { dimension: string }) => d.dimension === "产品取舍",
    );
    expect(tradeoff).toMatchObject({
      observed: true,
      observationCount: 2,
      statusLabel: "样本较少",
      hintDependencyBand: "高", // 近几次平均 3 次提示
    });
    expect(tradeoff.sparkline).toEqual([55, 65]);
    expect(tradeoff.recentScores).toEqual([55, 65]);
    // T18：recentEvaluations 时间倒序，与 sparkline 口径一致
    expect(
      tradeoff.recentEvaluations.map((e: { score: number }) => e.score),
    ).toEqual([65, 55]);

    // 未观测维度保持未知态（不显示 0 分）
    const unknown = json.data.dimensions.find(
      (d: { dimension: string }) => d.dimension === "根因分析",
    );
    expect(unknown).toMatchObject({ observed: false, currentScore: null, sparkline: [] });

    // 整体提示依赖 = 已观测维度提示依赖平均：((0+1+1+2)/4=1, 3) → (1+3)/2=2 → 中
    expect(json.data.hintDependencyOverall).toEqual({ average: 2, band: "中" });
  });

  it("最近评估记录上限 6 条（SPARKLINE_MAX_POINTS），时间倒序，字段齐全", async () => {
    const { id: userId, email } = await newUser();
    await ensureSeedQuestion();
    for (let d = 1; d <= 7; d += 1) {
      await seedScore(userId, "方案设计", 50 + d, 0, new Date(Date.UTC(2026, 9, d)));
    }
    await refreshAbilityProfile(prisma, userId, ["方案设计"]);

    const res = await GET(buildRequest(email));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    const design = json.data.dimensions.find(
      (d: { dimension: string }) => d.dimension === "方案设计",
    );
    expect(design.recentEvaluations).toHaveLength(6);
    expect(design.recentEvaluations.map((e: { score: number }) => e.score)).toEqual([
      57, 56, 55, 54, 53, 52,
    ]);
    for (const entry of design.recentEvaluations) {
      expect(entry.sessionId).toEqual(expect.any(String));
      expect(entry.caseTitle).toBe("T09 集成测试种子题");
      expect(new Date(entry.scoredAt).getTime()).not.toBeNaN();
    }
  });

  it("生产环境（T03 未接入）无会话：401，不放行", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { email } = await newUser();
    const res = await GET(buildRequest(email));
    expect(res.status).toBe(401);
    expect((await res.json()).success).toBe(false);
  });
});
