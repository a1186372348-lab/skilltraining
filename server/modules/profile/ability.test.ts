import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import {
  getAbilityProfileView,
  HINT_DEPENDENCY_WINDOW,
  hintDependencyBand,
  refreshAbilityProfile,
} from "./ability";
import { ABILITY_DIMENSIONS } from "./schema";

// 能力画像（BR-6/FR-6/FR-8）集成测试：真实数据库。
// 覆盖：历史有效分简单平均、观察次数累计、提示依赖分档（近 N 次）、趋势判定、
// 未知维度不建档（保持 NULL）、全维度画像读取（含未知态）。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

async function newUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `t06-profile-${randomUUID()}@example.com` },
  });
  createdUserIds.push(user.id);
  return user.id;
}

/** 直接写一条有效评分（构造画像数据源，绕过评分主链路） */
async function seedScore(
  userId: string,
  dimension: string,
  effectiveScore: number,
  hintCount: number,
  scoredAt: Date,
): Promise<void> {
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
      rawScore: effectiveScore, // 测试聚焦画像聚合，原始分与有效分取同值
      hintCount,
      coefficient: 1.0,
      effectiveScore,
      diagnosisText: "诊断",
    },
  });
}

const SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000a1";

async function ensureSeedQuestion(): Promise<void> {
  const data = {
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

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("hintDependencyBand：提示依赖分档", () => {
  it("低/中/高三档边界与未知态", () => {
    expect(hintDependencyBand(null)).toBeNull();
    expect(hintDependencyBand(0)).toBe("低");
    expect(hintDependencyBand(0.99)).toBe("低");
    expect(hintDependencyBand(1)).toBe("中");
    expect(hintDependencyBand(2.5)).toBe("中");
    expect(hintDependencyBand(2.51)).toBe("高");
    expect(hintDependencyBand(5)).toBe("高");
  });
});

describe("refreshAbilityProfile：画像更新（BR-6）", () => {
  it("首次观测：当前分=该次有效分、观察次数 1、趋势为 null（无上次可比）", async () => {
    await ensureSeedQuestion();
    const userId = await newUser();
    await seedScore(userId, "用户理解", 72, 1, new Date(Date.UTC(2026, 9, 1)));

    await refreshAbilityProfile(prisma, userId, ["用户理解"]);

    const row = await prisma.abilityProfile.findUnique({
      where: { userId_dimension: { userId, dimension: "用户理解" } },
    });
    expect(row).toMatchObject({
      currentScore: 72,
      observationCount: 1,
      hintDependency: 1,
      trend: null,
    });
  });

  it("维度当前分=历史有效分简单平均，观察次数随有效评分累计", async () => {
    const userId = await newUser();
    await seedScore(userId, "根因分析", 60, 0, new Date(Date.UTC(2026, 9, 1)));
    await seedScore(userId, "根因分析", 80, 2, new Date(Date.UTC(2026, 9, 2)));

    await refreshAbilityProfile(prisma, userId, ["根因分析"]);

    const row = await prisma.abilityProfile.findUnique({
      where: { userId_dimension: { userId, dimension: "根因分析" } },
    });
    expect(row?.currentScore).toBeCloseTo(70, 5); // (60+80)/2
    expect(row?.observationCount).toBe(2);
    expect(row?.hintDependency).toBeCloseTo(1, 5); // (0+2)/2
  });

  it("趋势分支：上升 / 下降 / 稳定（与上次分数比较）", async () => {
    const userId = await newUser();
    const day = (d: number) => new Date(Date.UTC(2026, 9, d));

    // 稳定：两次同分
    await seedScore(userId, "方案设计", 70, 0, day(1));
    await refreshAbilityProfile(prisma, userId, ["方案设计"]);
    await seedScore(userId, "方案设计", 70, 0, day(2));
    await refreshAbilityProfile(prisma, userId, ["方案设计"]);
    let row = await prisma.abilityProfile.findUnique({
      where: { userId_dimension: { userId, dimension: "方案设计" } },
    });
    expect(row?.trend).toBe("稳定");

    // 上升：第三次明显更高（70 → 80）
    await seedScore(userId, "方案设计", 100, 0, day(3));
    await refreshAbilityProfile(prisma, userId, ["方案设计"]);
    row = await prisma.abilityProfile.findUnique({
      where: { userId_dimension: { userId, dimension: "方案设计" } },
    });
    expect(row?.currentScore).toBeCloseTo(80, 5);
    expect(row?.trend).toBe("上升");

    // 下降：第四次明显更低（80 → 67.5）
    await seedScore(userId, "方案设计", 30, 0, day(4));
    await refreshAbilityProfile(prisma, userId, ["方案设计"]);
    row = await prisma.abilityProfile.findUnique({
      where: { userId_dimension: { userId, dimension: "方案设计" } },
    });
    expect(row?.trend).toBe("下降");
  });

  it("提示依赖取近 N 次平均（窗口外旧记录不计入）", async () => {
    const userId = await newUser();
    // 早期高提示（5 次）应被窗口挤出：共 N+2 条，近 N 条提示次数为 0
    await seedScore(userId, "产品表达", 50, 5, new Date(Date.UTC(2026, 8, 1)));
    await seedScore(userId, "产品表达", 50, 5, new Date(Date.UTC(2026, 8, 2)));
    for (let i = 0; i < HINT_DEPENDENCY_WINDOW; i += 1) {
      await seedScore(userId, "产品表达", 50, 0, new Date(Date.UTC(2026, 9, i + 1)));
    }

    await refreshAbilityProfile(prisma, userId, ["产品表达"]);

    const row = await prisma.abilityProfile.findUnique({
      where: { userId_dimension: { userId, dimension: "产品表达" } },
    });
    expect(row?.observationCount).toBe(HINT_DEPENDENCY_WINDOW + 2);
    expect(row?.hintDependency).toBe(0); // 近 N 次全部 0 提示
    expect(hintDependencyBand(row?.hintDependency ?? null)).toBe("低");
  });

  it("未知维度不建档：无有效评分时不写 ability_profiles", async () => {
    const userId = await newUser();
    await refreshAbilityProfile(prisma, userId, ["指标与验证"]);
    expect(
      await prisma.abilityProfile.count({ where: { userId, dimension: "指标与验证" } }),
    ).toBe(0);
  });

  it("入参维度去重：重复维度只处理一次", async () => {
    const userId = await newUser();
    await seedScore(userId, "产品取舍", 66, 1, new Date(Date.UTC(2026, 9, 1)));
    await refreshAbilityProfile(prisma, userId, ["产品取舍", "产品取舍"]);
    expect(
      await prisma.abilityProfile.count({ where: { userId, dimension: "产品取舍" } }),
    ).toBe(1);
  });
});

describe("getAbilityProfileView：全维度画像读取（FR-8）", () => {
  it("返回全部 8 个一级维度；未观测维度为未知态（NULL），已观测维度带分数/次数/依赖/趋势", async () => {
    const userId = await newUser();
    await seedScore(userId, "用户理解", 80, 1, new Date(Date.UTC(2026, 9, 1)));
    await refreshAbilityProfile(prisma, userId, ["用户理解"]);

    const view = await getAbilityProfileView(prisma, userId);
    expect(view.map((v) => v.dimension)).toEqual([...ABILITY_DIMENSIONS]);

    const known = view.find((v) => v.dimension === "用户理解")!;
    expect(known).toMatchObject({
      observed: true,
      currentScore: 80,
      observationCount: 1,
      hintDependency: 1,
      hintDependencyBand: "中",
      trend: null,
    });
    expect(known.updatedAt).not.toBeNull();

    const unknown = view.find((v) => v.dimension === "指标与验证")!;
    expect(unknown).toMatchObject({
      observed: false,
      currentScore: null,
      observationCount: 0,
      hintDependency: null,
      hintDependencyBand: null,
      trend: null,
      updatedAt: null,
    });
  });

  it("从未训练的用户：8 个维度全部未知态", async () => {
    const userId = await newUser();
    const view = await getAbilityProfileView(prisma, userId);
    expect(view).toHaveLength(8);
    expect(view.every((v) => !v.observed && v.currentScore === null)).toBe(true);
  });
});
