// 自适应出题验证脚本（T11）：对 3 种构造画像各跑一次选题，打印选题结果与可解释理由
// 用法：
//   node scripts/selection-demo.ts          # 真实 DB 模式：构造临时用户写入画像/会话，选题后清理
//   node scripts/selection-demo.ts --mock   # 离线 mock 模式：内置题池与画像，无需数据库
// 退出码：任一画像选题失败 → 1；全部成功 → 0
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import {
  selectQuestion,
  type CandidateQuestion,
  type ProfileDimensionView,
  type SelectionOutcome,
} from "../server/modules/selection/engine.ts";

// 8 个一级维度（与 server/modules/profile/schema.ts 的 ABILITY_DIMENSIONS 保持一致；
// 本脚本只 import 引擎，不 import 画像模块，以便 node 直接运行）
const ABILITY_DIMENSIONS = [
  "问题定义",
  "用户理解",
  "根因分析",
  "产品价值判断",
  "方案设计",
  "产品取舍",
  "指标与验证",
  "产品表达",
] as const;

/** 由数据库画像行构造全 8 维视图（与画像模块 getAbilityProfileView 同口径：未观测补齐未知态） */
function toProfileView(
  rows: Array<{ dimension: string; currentScore: number | null; hintDependency: number | null }>,
): ProfileDimensionView[] {
  const byDimension = new Map(rows.map((row) => [row.dimension, row]));
  return ABILITY_DIMENSIONS.map((dimension) => {
    const row = byDimension.get(dimension);
    if (!row || row.currentScore === null) {
      return {
        dimension,
        observed: false,
        currentScore: null,
        hintDependency: null,
        hintDependencyBand: null,
      };
    }
    const dep = row.hintDependency;
    return {
      dimension,
      observed: true,
      currentScore: row.currentScore,
      hintDependency: dep,
      hintDependencyBand: dep === null ? null : dep < 1 ? "低" : dep <= 2.5 ? "中" : "高",
    };
  });
}

function printOutcome(title: string, questionTitle: string, outcome: SelectionOutcome): void {
  console.log(`\n=== ${title} ===`);
  console.log(`阶段：${outcome.phase}（目标维度：${outcome.targetDimensions.join("、") || "无"}）`);
  console.log(`选中：${questionTitle}（${outcome.questionId}）`);
  console.log(`理由：${outcome.reason}`);
  if (outcome.relaxedFilters.length > 0) {
    console.log(`放宽过滤：${outcome.relaxedFilters.join("、")}`);
  }
}

// ───────────────────────── 离线 mock 模式 ─────────────────────────

function mockQuestion(overrides: Partial<CandidateQuestion> & { id: string }): CandidateQuestion {
  return {
    caseTitle: `案例 ${overrides.id}`,
    caseBackground: { product: `产品${overrides.id}——背景。` },
    mainQuestion: "主问题？",
    abilityTags: ["用户理解"],
    difficulty: 2,
    ...overrides,
  };
}

function runMockDemo(): void {
  console.log("【离线 mock 模式】内置题池 6 题 × 3 种画像");
  const pool: CandidateQuestion[] = [
    mockQuestion({
      id: "q-douyin",
      caseTitle: "短视频霸主为何「倒退」做图文",
      caseBackground: { product: "抖音——字节跳动旗下短视频平台，内容创作与电商生态。" },
      abilityTags: ["用户理解", "产品价值判断", "方案设计"],
      difficulty: 2,
    }),
    mockQuestion({
      id: "q-notion",
      caseTitle: "工具箱的边界：Notion 该做到哪一步",
      caseBackground: { product: "Notion——一体化工作空间，效率工具。" },
      abilityTags: ["问题定义", "产品价值判断", "方案设计"],
      difficulty: 3,
    }),
    mockQuestion({
      id: "q-keep",
      caseTitle: "当健身 App 一半收入来自卖货",
      caseBackground: { product: "Keep——健身应用，商城与电商收入。" },
      abilityTags: ["问题定义", "产品价值判断", "根因分析"],
      difficulty: 3,
    }),
    mockQuestion({
      id: "q-cursor",
      caseTitle: "从「帮你写」到「替你做」：Cursor 的 Agent 模式",
      caseBackground: { product: "Cursor——AI 编程工具。本题标注：独立性训练。" },
      abilityTags: ["用户理解", "产品价值判断", "产品取舍"],
      difficulty: 2,
    }),
    mockQuestion({
      id: "q-luckin",
      caseTitle: "当 9.9 元从促销变成日常",
      caseBackground: { product: "瑞幸——连锁咖啡，价格心智与指标验证。" },
      abilityTags: ["问题定义", "根因分析", "指标与验证"],
      difficulty: 3,
    }),
    mockQuestion({
      id: "q-amap",
      caseTitle: "从「导航用高德」到「生活用高德」",
      caseBackground: { product: "高德——地图导航工具，本地生活到店业务。" },
      abilityTags: ["产品价值判断", "方案设计", "指标与验证"],
      difficulty: 2,
    }),
  ];
  const titleOf = new Map(pool.map((q) => [q.id, q.caseTitle]));
  const observedAll = (weak: string, weakScore: number, weakDep: number): ProfileDimensionView[] =>
    ABILITY_DIMENSIONS.map((dimension) => {
      const score = dimension === weak ? weakScore : 78;
      const dep = dimension === weak ? weakDep : 0.4;
      return {
        dimension,
        observed: true,
        currentScore: score,
        hintDependency: dep,
        hintDependencyBand: dep < 1 ? "低" : dep <= 2.5 ? "中" : "高",
      };
    });

  // 画像 A：全未知 + 首次训练 + 熟悉产品「抖音」+ 兴趣「内容/创作」
  const a = selectQuestion({
    profile: ABILITY_DIMENSIONS.map((dimension) => ({
      dimension,
      observed: false,
      currentScore: null,
      hintDependency: null,
      hintDependencyBand: null,
    })),
    familiarProducts: ["抖音"],
    interestAreas: ["内容/创作"],
    questions: pool,
    practicedQuestionIds: new Set(),
    recentCaseBackgrounds: [],
    isFirstTraining: true,
  })!;
  printOutcome("画像 A：全未知 · 首次训练 · 熟悉抖音", titleOf.get(a.questionId)!, a);

  // 画像 B：7 维已观测，仅「指标与验证」未知；兴趣「出海/国际化」无匹配；已练 q-luckin
  const unknownOne = ABILITY_DIMENSIONS.map((dimension) =>
    dimension === "指标与验证"
      ? {
          dimension,
          observed: false,
          currentScore: null,
          hintDependency: null,
          hintDependencyBand: null,
        }
      : {
          dimension,
          observed: true,
          currentScore: 72,
          hintDependency: 0.5,
          hintDependencyBand: "低" as const,
        },
  );
  const b = selectQuestion({
    profile: unknownOne,
    familiarProducts: [],
    interestAreas: ["出海/国际化"],
    questions: pool,
    practicedQuestionIds: new Set(["q-luckin"]),
    recentCaseBackgrounds: [],
    isFirstTraining: false,
  })!;
  printOutcome("画像 B：部分观测 · 兴趣无匹配 · 已练一道覆盖题", titleOf.get(b.questionId)!, b);

  // 画像 C：全观测，弱项「产品取舍」52 分且提示依赖高；近期练过瑞幸同类案例（被过滤）
  const c = selectQuestion({
    profile: observedAll("产品取舍", 52, 3.4),
    familiarProducts: [],
    interestAreas: ["AI 应用"],
    questions: pool,
    practicedQuestionIds: new Set(),
    recentCaseBackgrounds: [{ product: "瑞幸——连锁咖啡，价格心智与指标验证。" }],
    isFirstTraining: false,
  })!;
  printOutcome("画像 C：全观测 · 弱项高提示依赖 · 近期同类案例", titleOf.get(c.questionId)!, c);
}

// ───────────────────────── 真实 DB 模式 ─────────────────────────

async function runDbDemo(): Promise<void> {
  const prisma = new PrismaClient();
  const createdUserIds: string[] = [];
  try {
    const published = await prisma.question.findMany({
      where: { status: "published" },
      orderBy: { id: "asc" },
    });
    if (published.length === 0) {
      console.error("题库暂无上架题目，无法演示。请先 npm run content:import 并上架题目。");
      process.exitCode = 1;
      return;
    }
    console.log(`【真实 DB 模式】当前上架题 ${published.length} 道：`);
    for (const q of published) {
      console.log(`  - ${q.caseTitle}（${q.id.slice(0, 8)}…，难度 ${q.difficulty}）`);
    }
    const titleOf = new Map(published.map((q) => [q.id, q.caseTitle]));

    async function newUser(): Promise<string> {
      const user = await prisma.user.create({
        data: { email: `t11-demo-${randomUUID()}@example.com` },
      });
      createdUserIds.push(user.id);
      return user.id;
    }

    /** 与服务层同等口径取数后调引擎（服务编排已由集成测试覆盖，此处聚焦选题结果对照） */
    async function runFor(userId: string, title: string): Promise<SelectionOutcome> {
      const [rows, profileRow, sessions] = await Promise.all([
        prisma.abilityProfile.findMany({ where: { userId } }),
        prisma.userProfile.findUnique({
          where: { userId },
          select: { familiarProducts: true, interestAreas: true },
        }),
        prisma.trainingSession.findMany({
          where: { userId },
          orderBy: { startedAt: "desc" },
          select: { questionId: true, question: { select: { caseBackground: true } } },
        }),
      ]);
      const strings = (raw: unknown): string[] =>
        Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
      const outcome = selectQuestion({
        profile: toProfileView(rows),
        familiarProducts: strings(profileRow?.familiarProducts),
        interestAreas: strings(profileRow?.interestAreas),
        questions: published,
        practicedQuestionIds: new Set(sessions.map((s) => s.questionId)),
        recentCaseBackgrounds: sessions.slice(0, 3).map((s) => s.question.caseBackground),
        isFirstTraining: sessions.length === 0,
      });
      if (!outcome) throw new Error(`${title}：选题返回空`);
      printOutcome(title, titleOf.get(outcome.questionId) ?? "（题库外）", outcome);
      return outcome;
    }

    // 画像 A：全新用户，熟悉产品填了上架题案例里的产品名
    const a = await newUser();
    await prisma.userProfile.create({
      data: {
        userId: a,
        position: "产品经理",
        yearsExperience: "1-3年",
        industry: "互联网/软件",
        familiarProducts: ["测试产品"],
        interestAreas: ["电商/交易"],
        selfAssessment: [],
      },
    });
    await runFor(a, "画像 A：全未知 · 首次训练 · 熟悉产品命中");

    // 画像 B：3 维已观测，且全部上架题都已练过（触发「已练题目」放宽，安排重练）
    const b = await newUser();
    for (const [dimension, score] of [
      ["用户理解", 66],
      ["产品价值判断", 74],
      ["方案设计", 70],
    ] as const) {
      await prisma.abilityProfile.create({
        data: { userId: b, dimension, currentScore: score, observationCount: 2, hintDependency: 0.5 },
      });
    }
    for (const [index, question] of published.entries()) {
      await prisma.trainingSession.create({
        data: {
          userId: b,
          questionId: question.id,
          date: new Date(Date.UTC(2026, 8, 1 + index)),
        },
      });
    }
    await runFor(b, "画像 B：部分观测 · 全部上架题已练过（放宽重练）");

    // 画像 C：8 维全观测，弱项「产品取舍」50 分、提示依赖高
    const c = await newUser();
    for (const dimension of ABILITY_DIMENSIONS) {
      const weak = dimension === "产品取舍";
      await prisma.abilityProfile.create({
        data: {
          userId: c,
          dimension,
          currentScore: weak ? 50 : 76,
          observationCount: 4,
          hintDependency: weak ? 3.4 : 0.5,
        },
      });
    }
    await runFor(c, "画像 C：全观测 · 弱项「产品取舍」高提示依赖");

    console.log("\n全部画像选题成功。");
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  }
}

if (process.argv.includes("--mock")) {
  runMockDemo();
} else {
  await runDbDemo();
}
