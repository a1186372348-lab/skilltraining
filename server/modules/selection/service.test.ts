import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import { SELECTION_ERROR_CODES, SelectionError } from "./errors";
import { selectTodayQuestion, type SelectionRepository } from "./service";

// 选题服务（US-010 / FR-2）集成测试：真实数据库。
// 覆盖：仅 published 参与选题、探索期选题与理由输出、已练过滤、
// 画像读取（ability_profiles 未知维度判定）、user_profiles 熟悉产品/兴趣领域读取、
// 异常降级为「顺序取未练题」、空题库抛 SelectionError。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];
const createdQuestionIds: string[] = [];

async function newUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `t11-selection-${randomUUID()}@example.com` },
  });
  createdUserIds.push(user.id);
  return user.id;
}

function questionData(overrides: {
  caseTitle: string;
  product: string;
  abilityTags: string[];
  difficulty?: number;
  status?: "draft" | "published";
}) {
  return {
    caseTitle: overrides.caseTitle,
    caseBackground: {
      product: overrides.product,
      audience: "测试用户",
      scenario: "测试场景",
      related_features: "测试功能",
      current_status: "测试现状",
    },
    mainQuestion: "测试主问题？",
    abilityTags: overrides.abilityTags,
    difficulty: overrides.difficulty ?? 2,
    rubric: {
      dimensions: Object.fromEntries(
        overrides.abilityTags.map((d) => [d, ["要点1", "要点2", "要点3"]]),
      ),
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
    status: overrides.status ?? ("published" as const),
  };
}

/** 造一道题并入池；返回题目 id */
async function seedQuestion(
  overrides: Parameters<typeof questionData>[0],
): Promise<string> {
  const question = await prisma.question.create({ data: questionData(overrides) });
  createdQuestionIds.push(question.id);
  return question.id;
}

// 共享开发库已导入真实上架题：归档除共享种子题（其他测试文件依赖其保持上架）外的
// 全部上架题，使本文件选题结果确定；各用例再自建本用例的题目
const SHARED_SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000a1";

async function archiveOtherPublishedQuestions(): Promise<void> {
  await prisma.question.updateMany({
    where: { status: "published", id: { not: SHARED_SEED_QUESTION_ID } },
    data: { status: "archived" },
  });
}

/** 防御并发测试文件的归档：选题前确保本题处于上架状态 */
async function ensurePublished(questionId: string): Promise<void> {
  await prisma.question.update({ where: { id: questionId }, data: { status: "published" } });
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.question.deleteMany({ where: { id: { in: createdQuestionIds } } });
  await prisma.$disconnect();
});

describe("selectTodayQuestion：真实 DB 选题", () => {
  it("全未知画像 → 探索期，仅 published 参与，输出可解释理由", async () => {
    const userId = await newUser();
    // 共享库已有真实上架题（含命中「电商」兴趣的案例）：先归档，只留本用例题目参与选题
    await archiveOtherPublishedQuestions();
    await prisma.userProfile.create({
      data: {
        userId,
        position: "产品经理",
        yearsExperience: "1-3年",
        industry: "互联网/软件",
        familiarProducts: ["测试熟悉产品"],
        interestAreas: ["电商/交易"],
        selfAssessment: [],
      },
    });
    const draftOnly = await seedQuestion({
      caseTitle: "覆盖未知维度的草稿题",
      product: "草稿产品——不应被选中。",
      abilityTags: ["根因分析"],
      status: "draft",
    });
    const published = await seedQuestion({
      caseTitle: "电商价格心智案例",
      product: "测试咖啡品牌——电商与交易场景。",
      abilityTags: ["根因分析", "指标与验证"],
      difficulty: 2,
    });
    await ensurePublished(published);

    const result = await selectTodayQuestion(prisma, userId);

    expect(result.question.id).toBe(published);
    expect(result.question.id).not.toBe(draftOnly);
    expect(result.degraded).toBe(false);
    expect(result.outcome.phase).toBe("exploration");
    expect(result.outcome.reason).toContain("探索期");
    // 首次训练 + 兴趣命中
    expect(result.outcome.matchedInterest).toBe("电商/交易");
  });

  it("已练题被过滤：除 q2 外全部练过后只能选 q2", async () => {
    const userId = await newUser();
    const q2 = await seedQuestion({
      caseTitle: "第二题",
      product: "乙产品——背景。",
      abilityTags: ["根因分析"],
    });
    // 把当前题库里除 q2 外的全部上架题标记为已练（含其他测试的共享种子题），
    // 保证断言不依赖全局题库状态
    const others = await prisma.question.findMany({
      where: { status: "published", id: { not: q2 } },
      select: { id: true },
    });
    for (const [index, other] of others.entries()) {
      await prisma.trainingSession.create({
        data: {
          userId,
          questionId: other.id,
          date: new Date(Date.UTC(2026, 8, 1 + index)),
        },
      });
    }

    await ensurePublished(q2);

    const result = await selectTodayQuestion(prisma, userId);
    expect(result.question.id).toBe(q2);
  });

  it("部分观测画像：未知维度取自 ability_profiles 之外", async () => {
    const userId = await newUser();
    // 共享库已有覆盖「产品表达」的真实上架题：先归档，只留本用例题目参与选题
    await archiveOtherPublishedQuestions();
    // 7 维已观测，仅「产品表达」未知
    const known = [
      "问题定义",
      "用户理解",
      "根因分析",
      "产品价值判断",
      "方案设计",
      "产品取舍",
      "指标与验证",
    ];
    for (const dimension of known) {
      await prisma.abilityProfile.create({
        data: { userId, dimension, currentScore: 70, observationCount: 2, hintDependency: 0 },
      });
    }
    const target = await seedQuestion({
      caseTitle: "产品表达案例",
      product: "丙产品——背景。",
      abilityTags: ["产品表达"],
    });
    await ensurePublished(target);

    const result = await selectTodayQuestion(prisma, userId);
    expect(result.question.id).toBe(target);
    expect(result.outcome.targetDimensions).toEqual(["产品表达"]);
  });
});

describe("selectTodayQuestion：降级与空池", () => {
  /** 构造一个必抛异常的仓储，验证服务层降级 */
  function failingRepository(): SelectionRepository {
    return {
      async getProfileView(): Promise<never> {
        throw new Error("仓储不可用");
      },
      async getProfilePreferences(): Promise<never> {
        throw new Error("仓储不可用");
      },
      async listPublishedQuestions(): Promise<never> {
        throw new Error("仓储不可用");
      },
      async listSessionHistory(): Promise<never> {
        throw new Error("仓储不可用");
      },
    };
  }

  /** 降级路径直连 db 的确定性 mock：按 id 升序、排除已练 */
  function fakeFallbackDb(practicedIds: string[], publishedIds: string[]): PrismaClient {
    return {
      trainingSession: {
        findMany: async () => practicedIds.map((questionId) => ({ questionId })),
      },
      question: {
        findFirst: async (args: { where: { id?: { notIn?: string[] } } }) => {
          const excluded = new Set(args.where.id?.notIn ?? []);
          const id = [...publishedIds].sort().find((candidate) => !excluded.has(candidate));
          return id ? { id } : null;
        },
      },
    } as unknown as PrismaClient;
  }

  it("选题异常 → 降级为「顺序取未练题」，不阻塞训练", async () => {
    const db = fakeFallbackDb([], ["q-bbb", "q-aaa"]);

    const result = await selectTodayQuestion(db, "user-1", {
      repository: failingRepository(),
    });

    expect(result.degraded).toBe(true);
    expect(result.outcome.phase).toBe("fallback");
    expect(result.outcome.reason).toContain("降级");
    expect(result.question.id).toBe("q-aaa"); // id 升序第一道未练题
  });

  it("降级路径同样过滤已练题；全部练过时安排重练第一题", async () => {
    const practiced = await selectTodayQuestion(
      fakeFallbackDb(["q-aaa"], ["q-aaa", "q-bbb"]),
      "user-1",
      { repository: failingRepository() },
    );
    expect(practiced.degraded).toBe(true);
    expect(practiced.question.id).toBe("q-bbb");

    const allPracticed = await selectTodayQuestion(
      fakeFallbackDb(["q-aaa", "q-bbb"], ["q-aaa", "q-bbb"]),
      "user-1",
      { repository: failingRepository() },
    );
    expect(allPracticed.question.id).toBe("q-aaa");
  });

  it("降级后仍无任何上架题 → 抛 SelectionError(NO_PUBLISHED_QUESTION)", async () => {
    await expect(
      selectTodayQuestion(fakeFallbackDb([], []), "user-1", {
        repository: failingRepository(),
      }),
    ).rejects.toMatchObject({
      name: "SelectionError",
      code: SELECTION_ERROR_CODES.NO_PUBLISHED_QUESTION,
    });
  });

  it("题库无任何上架题 → 抛 SelectionError(NO_PUBLISHED_QUESTION)", async () => {
    const emptyRepository: SelectionRepository = {
      async getProfileView() {
        return [];
      },
      async getProfilePreferences() {
        return { familiarProducts: [], interestAreas: [] };
      },
      async listPublishedQuestions() {
        return [];
      },
      async listSessionHistory() {
        return [];
      },
    };
    // 仓储正常返回空池：引擎给出确定性「无题可选」，直接抛错不再降级重试
    await expect(
      selectTodayQuestion(fakeFallbackDb([], []), "user-1", { repository: emptyRepository }),
    ).rejects.toBeInstanceOf(SelectionError);
    await expect(
      selectTodayQuestion(fakeFallbackDb([], []), "user-1", { repository: emptyRepository }),
    ).rejects.toMatchObject({ code: SELECTION_ERROR_CODES.NO_PUBLISHED_QUESTION });
  });
});
