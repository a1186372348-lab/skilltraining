import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { TrainingPlan } from "@prisma/client";

import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";

import { SELECTION_ERROR_CODES, SelectionError } from "./errors";
import type { CandidateQuestion } from "./engine";
import { getPlanProgress, weekStartUtc } from "@/server/modules/planning";
import { getOrCreateTodaySession } from "@/server/modules/training/service";

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

  it("已终止（abandoned）会话的题同样视为已练被过滤（T38 / D40③：重启后不再选到被终止题）", async () => {
    const userId = await newUser();
    const q2 = await seedQuestion({
      caseTitle: "重启后的新题",
      product: "丙产品——背景。",
      abilityTags: ["根因分析"],
    });
    // 除 q2 外的全部上架题都以 abandoned 会话关联（唯一会话即终止态）：
    // 已练排除语义为「存在任何状态的会话」，终止题不会再被选到
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
          state: "abandoned",
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

  it("画像异步失败且计划依赖同步失败时，仍收集所有拒绝并保留降级", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await selectTodayQuestion(fakeFallbackDb([], ["q-aaa"]), "user-1", {
        repository: failingRepository(),
        getCurrentPlan: () => { throw new Error("plan store down"); },
        hasPlanSessionToday: async () => false,
      });
      expect(result.degraded).toBe(true);
      expect(result.question.id).toBe("q-aaa");
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("plan store down"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      warning.mockRestore();
    }
  });
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

describe("selection 强化期回归验证（T27 / BR-V2-4：八维均有观测后自然进入强化期，selection 不改代码）", () => {
  it("八维均有有效分（currentScore 非空）→ 阶段 = 强化期，目标维度 = 最低分维度", async () => {
    const userId = await newUser();
    await archiveOtherPublishedQuestions();
    const questionId = await seedQuestion({
      caseTitle: "指标与验证薄弱点训练题",
      product: "测试产品",
      abilityTags: ["指标与验证"],
    });
    await ensurePublished(questionId);
    // 八维全部有观测（最低分为指标与验证 55）
    const scores: [string, number][] = [
      ["问题定义", 80],
      ["用户理解", 76],
      ["根因分析", 82],
      ["产品价值判断", 70],
      ["方案设计", 78],
      ["产品取舍", 74],
      ["指标与验证", 55],
      ["产品表达", 88],
    ];
    await prisma.abilityProfile.createMany({
      data: scores.map(([dimension, currentScore]) => ({
        userId,
        dimension,
        currentScore,
        observationCount: 2,
      })),
    });

    const result = await selectTodayQuestion(prisma, userId);
    expect(result.outcome.phase).toBe("strengthening");
    expect(result.outcome.targetDimensions).toEqual(["指标与验证"]); // 最弱维度即主攻方向
    expect(result.question.id).toBe(questionId);
  });

  it("对照：一维未知（currentScore 为 NULL）→ 阶段 = 探索期（BR-V2-4 未知维度不参与主攻）", async () => {
    const userId = await newUser();
    await archiveOtherPublishedQuestions();
    const questionId = await seedQuestion({
      caseTitle: "覆盖未知维度题",
      product: "测试产品",
      abilityTags: ["产品表达"],
    });
    await ensurePublished(questionId);
    const scores: [string, number | null][] = [
      ["问题定义", 80],
      ["用户理解", 76],
      ["根因分析", 82],
      ["产品价值判断", 70],
      ["方案设计", 78],
      ["产品取舍", 74],
      ["指标与验证", 55],
      ["产品表达", null], // 未知维度
    ];
    await prisma.abilityProfile.createMany({
      data: scores.map(([dimension, currentScore]) => ({
        userId,
        dimension,
        currentScore,
        observationCount: currentScore === null ? 0 : 2,
      })),
    });

    const result = await selectTodayQuestion(prisma, userId);
    expect(result.outcome.phase).toBe("exploration");
    expect(result.outcome.targetDimensions).toEqual(["产品表达"]); // 探索期优先覆盖未知维度
  });
});

describe("selectTodayQuestion：计划层接入（T29 / BR-V2-1：本周计划维度优先于纯自适应弱项）", () => {
  const PLAN_ID = randomUUID();

  /** 本周计划（active/rejected 可配；聚焦维度默认「指标与验证」） */
  function makePlan(overrides: Partial<TrainingPlan> = {}): TrainingPlan {
    return {
      id: PLAN_ID,
      userId: "user-1",
      weekStartDate: new Date(Date.UTC(2026, 9, 19)),
      focusDimension: "指标与验证",
      startScore: 55,
      targetScore: 65,
      status: "active",
      reason: "「指标与验证」是你当前最弱的维度（当前 55 分），本周集中攻它，目标 65 分。",
      createdAt: new Date(),
      ...overrides,
    } as TrainingPlan;
  }

  /** 引擎数据全桩的仓储：画像八维齐全（最弱=用户理解 40）、无偏好、无历史 */
  function unitRepository(questions: CandidateQuestion[]): SelectionRepository {
    return {
      getProfileView: async () =>
        ABILITY_DIMENSIONS.map((dimension) => ({
          dimension,
          observed: true,
          currentScore: dimension === "用户理解" ? 40 : 75,
          hintDependency: null,
          hintDependencyBand: null,
        })) as never,
      getProfilePreferences: async () => ({ familiarProducts: [], interestAreas: [] }),
      listPublishedQuestions: async () => questions,
      listSessionHistory: async () => [],
    };
  }

  const PLAN_TAGGED: CandidateQuestion = {
    id: "q-plan-dim",
    caseTitle: "主攻维度题",
    caseBackground: { product: "计划产品" },
    mainQuestion: "主攻维度主问题？",
    abilityTags: ["指标与验证"],
    difficulty: 2,
  };
  const OTHER_TAGGED: CandidateQuestion = {
    id: "q-other-dim",
    caseTitle: "其他维度题",
    caseBackground: { product: "其他产品" },
    mainQuestion: "其他维度主问题？",
    abilityTags: ["产品表达"],
    difficulty: 2,
  };
  const ADAPTIVE_TAGGED: CandidateQuestion = {
    id: "q-adaptive-dim",
    caseTitle: "自适应弱项题",
    caseBackground: { product: "自适应产品" },
    mainQuestion: "自适应弱项主问题？",
    abilityTags: ["用户理解"],
    difficulty: 2,
  };

  it("计划 active 且今日未练 plan 题 → 命中主攻维度题：sourceType=plan、sourceId=计划 id、理由含计划文案与维度名", async () => {
    const result = await selectTodayQuestion(({} as unknown as PrismaClient), "user-1", {
      repository: unitRepository([OTHER_TAGGED, ADAPTIVE_TAGGED, PLAN_TAGGED]),
      getCurrentPlan: async () => makePlan(),
      hasPlanSessionToday: async () => false,
    });
    expect(result.degraded).toBe(false);
    expect(result.question.id).toBe("q-plan-dim"); // 主攻维度题，而非自适应弱项题
    expect(result.outcome.sourceType).toBe("plan");
    expect(result.outcome.sourceId).toBe(PLAN_ID);
    expect(result.outcome.reason).toContain("指标与验证");
    expect(result.outcome.reason).toContain("本周"); // 理由来源可追溯（计划层）
  });

  it("计划 rejected 后本周选题不再命中该维度、不重复推荐（落自适应且避开主攻维度题）", async () => {
    const result = await selectTodayQuestion(({} as unknown as PrismaClient), "user-1", {
      repository: unitRepository([PLAN_TAGGED, ADAPTIVE_TAGGED]),
      getCurrentPlan: async () => makePlan({ status: "rejected" }),
      hasPlanSessionToday: async () => false,
    });
    expect(result.outcome.sourceType).toBe("daily");
    expect(result.question.id).toBe("q-adaptive-dim"); // 自适应弱项（用户理解 40 分）题
    expect(result.question.id).not.toBe("q-plan-dim"); // 不重复推荐主攻维度
  });

  it("拒绝计划后自适应仍可选中相同维度，来源为 daily", async () => {
    const result = await selectTodayQuestion({} as PrismaClient, "user-1", {
      repository: unitRepository([PLAN_TAGGED]),
      getCurrentPlan: async () => makePlan({ status: "rejected" }),
      hasPlanSessionToday: async () => false,
    });
    expect(result.question.id).toBe("q-plan-dim");
    expect(result.outcome.sourceType).toBe("daily");
  });

  it("今日已练 plan 题 → 落自适应分支", async () => {
    const result = await selectTodayQuestion(({} as unknown as PrismaClient), "user-1", {
      repository: unitRepository([PLAN_TAGGED, ADAPTIVE_TAGGED]),
      getCurrentPlan: async () => makePlan(),
      hasPlanSessionToday: async () => true,
    });
    expect(result.outcome.sourceType).toBe("daily");
    expect(result.question.id).toBe("q-adaptive-dim");
  });

  it("主攻维度无可用未练题 → 落自适应，不空转不报错", async () => {
    // 计划维度题已练过（历史已练集合覆盖），剩余题均不含主攻维度
    const repo = unitRepository([PLAN_TAGGED, ADAPTIVE_TAGGED]);
    repo.listSessionHistory = async () => [{ questionId: "q-plan-dim", caseBackground: { product: "计划产品" } }];
    const result = await selectTodayQuestion(({} as unknown as PrismaClient), "user-1", {
      repository: repo,
      getCurrentPlan: async () => makePlan(),
      hasPlanSessionToday: async () => false,
    });
    expect(result.degraded).toBe(false);
    expect(result.outcome.sourceType).toBe("daily");
    expect(result.question.id).toBe("q-adaptive-dim");
  });

  it("未知维度导致计划未生成（无计划记录）→ 选题完全不受影响（自适应照常）", async () => {
    const result = await selectTodayQuestion(({} as unknown as PrismaClient), "user-1", {
      repository: unitRepository([PLAN_TAGGED, ADAPTIVE_TAGGED]),
      getCurrentPlan: async () => null, // PROFILE_INCOMPLETE 下计划未生成
      hasPlanSessionToday: async () => false,
    });
    expect(result.degraded).toBe(false);
    expect(result.outcome.sourceType).toBe("daily");
    expect(result.question.id).toBe("q-adaptive-dim"); // 自适应弱项照常
  });
});

describe("跨模块端到端：选题命中计划层 → 会话落 plan → 进度聚合计数（T29 切片 3 证据）", () => {
  it("计划 active 用户：选题命中主攻维度 → 建会话 sourceType=plan → 评完分后 getPlanProgress 计为 1", async () => {
    const userId = await newUser();
    await archiveOtherPublishedQuestions();
    // 主攻维度「根因分析」的上架题
    const questionId = await seedQuestion({
      caseTitle: "根因分析计划题",
      product: "测试产品",
      abilityTags: ["根因分析"],
    });
    await ensurePublished(questionId);
    const plan = await prisma.trainingPlan.create({
      data: {
        userId,
        weekStartDate: weekStartUtc(new Date()), // 本周一（默认计划读取按周一对齐）
        focusDimension: "根因分析",
        startScore: 55,
        targetScore: 65,
        reason: "「根因分析」是你当前最弱的维度（当前 55 分），本周集中攻它，目标 65 分。",
      },
    });

    // 选题（真实仓储 + 真实计划读取：默认 deps 走 planning 仓储与今日 plan 会话查询）
    const picked = await selectTodayQuestion(prisma, userId);
    expect(picked.outcome.sourceType).toBe("plan");
    expect(picked.outcome.sourceId).toBe(plan.id);
    // 共享测试库并行文件可能并发上架同维度题：计划层按 id 升序取第一道，
    // 本用例只锁定「命中主攻维度 + 计划来源」链路，不断言具体题 id（抗并发）
    expect(picked.question.id).toBeTruthy();
    expect((picked.question.abilityTags as string[])).toContain("根因分析");

    // 建会话（透传落库）
    const { session } = await getOrCreateTodaySession(prisma, userId);
    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.sourceType).toBe("plan");
    expect(row.sourceId).toBe(plan.id);

    // 评分完成 → 进度聚合计数（切片 2 planning 仓储口径）
    expect(await getPlanProgress(prisma, userId, plan)).toEqual({ scoredCount: 0, completedDays: 0, completedDates: [] });
    await prisma.trainingSession.update({
      where: { id: session.id },
      data: { scoredAt: new Date() },
    });
    expect(await getPlanProgress(prisma, userId, plan)).toEqual({ scoredCount: 1, completedDays: 1, completedDates: [new Date().toISOString().slice(0, 10)] });
  });
});
