import { randomUUID } from "node:crypto";

import { PrismaClient, type Question } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SCORING_ERROR_CODES as CODES } from "./errors";
import { scoreSession } from "./service";
import type { RubricScoringInput, RubricScoringOutput } from "./rubric-scorer";

// 评分服务集成测试：打真实数据库（docker PostgreSQL:5433），AI 评分以注入假实现 mock。
// 覆盖：MARK_SCORED 状态推进、四元组落库（D8）、幂等（US-006）、有效分系数（BR-1/BR-2）、
// 画像联动（BR-6/FR-6）、AI 失败可安全重试、解析兜底。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

// 与 training 模块测试共用的上架种子题（upsert 保证跨文件并发播种一致）
const SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000a1";
const SEED_DIMENSIONS = ["用户理解", "产品价值判断", "产品取舍"];

const SEED_QUESTION_DATA = {
  id: SEED_QUESTION_ID,
  caseTitle: "T05 集成测试种子题",
  caseBackground: { product: "测试产品", audience: "测试用户", scenario: "测试场景" },
  mainQuestion: "测试主问题？",
  abilityTags: SEED_DIMENSIONS,
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

async function ensureSeedQuestion(): Promise<Question> {
  const { id, ...data } = SEED_QUESTION_DATA;
  try {
    return await prisma.question.upsert({ where: { id }, create: SEED_QUESTION_DATA, update: data });
  } catch {
    return prisma.question.findUniqueOrThrow({ where: { id: SEED_QUESTION_ID } });
  }
}

async function newUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `t06-scoring-${randomUUID()}@example.com` },
  });
  createdUserIds.push(user.id);
  return user.id;
}

/** 直接造一个待评分会话（终答已提交，状态 followup） */
async function seedScorableSession(
  userId: string,
  overrides: Partial<{
    state: "reading" | "answering" | "followup" | "scored";
    hintCount: number;
    followupHintCount: number;
    finalAnswer: string | null;
    finalSubmittedAt: Date | null;
  }> = {},
) {
  return prisma.trainingSession.create({
    data: {
      userId,
      questionId: SEED_QUESTION_ID,
      date: new Date(Date.UTC(2026, 9, 3)),
      state: overrides.state ?? "followup",
      hintCount: overrides.hintCount ?? 0,
      followupHintCount: overrides.followupHintCount ?? 0,
      firstAnswer: "首答全文",
      firstSubmittedAt: new Date(Date.UTC(2026, 9, 3, 1)),
      finalAnswer: overrides.finalAnswer === undefined ? "终答全文" : overrides.finalAnswer,
      finalSubmittedAt:
        overrides.finalSubmittedAt === undefined
          ? new Date(Date.UTC(2026, 9, 3, 2))
          : overrides.finalSubmittedAt,
      followups: [{ round: 1, question: "追问一" }],
    },
  });
}

/** 构造 mock 评分实现：可按维度给分，记录入参 */
function fakeScorer(
  rawScores: Record<string, number>,
  tracker?: { calls: number; lastInput?: RubricScoringInput },
) {
  return async (input: RubricScoringInput): Promise<RubricScoringOutput> => {
    if (tracker) {
      tracker.calls += 1;
      tracker.lastInput = input;
    }
    return {
      dimensions: Object.keys(input.rubricDimensions).map((dimension) => ({
        dimension,
        rawScore: rawScores[dimension] ?? 70,
        diagnosis: `${dimension}诊断：引用了终答中的具体证据。`,
      })),
      topIssue: "终答中「效率更高」的断言缺少衡量口径，应补充具体指标。",
      nextFocus: "下一步练「产品价值判断」中的价值量化类问题。",
    };
  };
}

beforeAll(async () => {
  await ensureSeedQuestion();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }); // 级联清理会话/评分/反馈/画像
  await prisma.$disconnect();
});

describe("scoreSession：评分主链路（US-006/FR-5）", () => {
  it("四元组按维度落库、会话反馈写入、状态经 MARK_SCORED 推进 scored、画像建档", async () => {
    const userId = await newUser();
    const session = await seedScorableSession(userId, { hintCount: 2 });
    const tracker = { calls: 0, lastInput: undefined as RubricScoringInput | undefined };

    const result = await scoreSession(prisma, session.id, userId, {
      scoreWithRubric: fakeScorer({ 用户理解: 80, 产品价值判断: 60, 产品取舍: 100 }, tracker),
    });

    // AI 只对该题能力标签覆盖的维度评分（BR-1），且拿到首答/追问/终答全文
    expect(tracker.calls).toBe(1);
    expect(Object.keys(tracker.lastInput!.rubricDimensions).sort()).toEqual(
      [...SEED_DIMENSIONS].sort(),
    );
    expect(tracker.lastInput!.firstAnswer).toBe("首答全文");
    expect(tracker.lastInput!.followupQuestions).toEqual(["追问一"]);
    expect(tracker.lastInput!.finalAnswer).toBe("终答全文");

    // 有效分 = 原始分 × max(0.6, 1 − 0.1×2) = 原始分 × 0.8（BR-1/BR-2）
    expect(result.state).toBe("scored");
    expect(result.scores.map((s) => s.dimension)).toEqual(SEED_DIMENSIONS);
    for (const s of result.scores) {
      expect(s.hintCount).toBe(2);
      expect(s.coefficient).toBe(0.8);
      expect(s.effectiveScore).toBeCloseTo(s.rawScore * 0.8, 5);
    }
    expect(result.feedback.topIssueText).toContain("衡量口径");
    expect(result.feedback.nextFocusText).toContain("产品价值判断");

    // D8：四元组分开落库（原始值，不存推导覆盖）
    const rows = await prisma.score.findMany({ where: { sessionId: session.id } });
    expect(rows).toHaveLength(3);
    const userRow = rows.find((r) => r.dimension === "用户理解")!;
    expect(userRow).toMatchObject({ rawScore: 80, hintCount: 2, coefficient: 0.8 });
    expect(userRow.effectiveScore).toBeCloseTo(64, 5);
    expect(userRow.diagnosisText).toContain("用户理解诊断");

    const feedback = await prisma.sessionFeedback.findUnique({ where: { sessionId: session.id } });
    expect(feedback?.topIssueText).toContain("衡量口径");

    const fresh = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(fresh.state).toBe("scored");
    expect(fresh.scoredAt).not.toBeNull();

    // 画像联动（BR-6/FR-6）：首次观测——当前分=有效分、观察 1 次、无趋势
    const profile = await prisma.abilityProfile.findUnique({
      where: { userId_dimension: { userId, dimension: "用户理解" } },
    });
    expect(profile?.currentScore).toBeCloseTo(64, 5);
    expect(profile?.observationCount).toBe(1);
    expect(profile?.hintDependency).toBeCloseTo(2, 5);
    expect(profile?.trend).toBeNull();
  });

  it("系数分支：0 次提示 ×1.0；5 次提示 ×0.6（BR-2 对照表两端）", async () => {
    const userId = await newUser();
    const noHint = await seedScorableSession(userId, { hintCount: 0 });
    const r1 = await scoreSession(prisma, noHint.id, userId, {
      scoreWithRubric: fakeScorer({ 用户理解: 90 }),
    });
    expect(r1.scores.find((s) => s.dimension === "用户理解")).toMatchObject({
      coefficient: 1.0,
      effectiveScore: 90,
    });

    const maxHint = await seedScorableSession(userId, { hintCount: 5 });
    const r2 = await scoreSession(prisma, maxHint.id, userId, {
      scoreWithRubric: fakeScorer({ 用户理解: 90 }),
    });
    expect(r2.scores.find((s) => s.dimension === "用户理解")).toMatchObject({
      coefficient: 0.6,
      effectiveScore: 54,
    });
  });

  it("追问提示半价计入系数（BR-2 修订 / D22）：hint=1 + followupHint=1 → 0.85 落四元组", async () => {
    const userId = await newUser();
    const session = await seedScorableSession(userId, { hintCount: 1, followupHintCount: 1 });
    const result = await scoreSession(prisma, session.id, userId, {
      scoreWithRubric: fakeScorer({ 用户理解: 80 }),
    });
    const userScore = result.scores.find((s) => s.dimension === "用户理解")!;
    expect(userScore.coefficient).toBe(0.85);
    expect(userScore.effectiveScore).toBeCloseTo(68, 5); // 80 × 0.85

    const row = await prisma.score.findFirstOrThrow({
      where: { sessionId: session.id, dimension: "用户理解" },
    });
    expect(row.coefficient).toBe(0.85);
  });

  it("追问提示与首答前提示共用 0.6 下限：hint=4 + followupHint=3 → 0.6", async () => {
    const userId = await newUser();
    const session = await seedScorableSession(userId, { hintCount: 4, followupHintCount: 3 });
    const result = await scoreSession(prisma, session.id, userId, {
      scoreWithRubric: fakeScorer({ 用户理解: 90 }),
    });
    expect(result.scores.find((s) => s.dimension === "用户理解")).toMatchObject({
      coefficient: 0.6,
      effectiveScore: 54,
    });
  });

  it("幂等：重复触发评分返回既有结果，不重复调 AI、不重复落库", async () => {
    const userId = await newUser();
    const session = await seedScorableSession(userId, { hintCount: 1 });
    const tracker = { calls: 0, lastInput: undefined as RubricScoringInput | undefined };
    const deps = { scoreWithRubric: fakeScorer({ 用户理解: 75 }, tracker) };

    const first = await scoreSession(prisma, session.id, userId, deps);
    const second = await scoreSession(prisma, session.id, userId, deps);

    expect(tracker.calls).toBe(1); // AI 未被重复调用
    expect(second.scores).toEqual(first.scores);
    expect(second.feedback).toEqual(first.feedback);
    expect(await prisma.score.count({ where: { sessionId: session.id } })).toBe(3);
    expect(await prisma.sessionFeedback.count({ where: { sessionId: session.id } })).toBe(1);

    const profile = await prisma.abilityProfile.findUnique({
      where: { userId_dimension: { userId, dimension: "用户理解" } },
    });
    expect(profile?.observationCount).toBe(1); // 未重复累计观察次数
  });

  it("AI 评分失败：不落地任何数据、状态停留 followup，可安全重试成功", async () => {
    const userId = await newUser();
    const session = await seedScorableSession(userId);
    let shouldFail = true;
    const flaky = async (input: RubricScoringInput): Promise<RubricScoringOutput> => {
      if (shouldFail) throw new Error("网关超时");
      return fakeScorer({})(input);
    };

    await expect(
      scoreSession(prisma, session.id, userId, { scoreWithRubric: flaky }),
    ).rejects.toThrow("网关超时");
    expect(await prisma.score.count({ where: { sessionId: session.id } })).toBe(0);
    const mid = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(mid.state).toBe("followup");

    shouldFail = false;
    const retried = await scoreSession(prisma, session.id, userId, { scoreWithRubric: flaky });
    expect(retried.state).toBe("scored");
    expect(await prisma.score.count({ where: { sessionId: session.id } })).toBe(3);
  });

  it("评分输出缺维度：抛 SCORING_OUTPUT_INVALID，不落半截数据", async () => {
    const userId = await newUser();
    const session = await seedScorableSession(userId);
    const badScorer = async (): Promise<RubricScoringOutput> => ({
      dimensions: [{ dimension: "用户理解", rawScore: 80, diagnosis: "诊断" }],
      topIssue: "具体问题",
      nextFocus: "下一步",
    });

    await expect(
      scoreSession(prisma, session.id, userId, { scoreWithRubric: badScorer }),
    ).rejects.toMatchObject({ code: CODES.SCORING_OUTPUT_INVALID });
    expect(await prisma.score.count({ where: { sessionId: session.id } })).toBe(0);
    const fresh = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(fresh.state).toBe("followup");
  });

  it("并发重复触发：守卫未命中的一方回滚，按幂等返回抢先一方的结果（四元组不被覆盖）", async () => {
    const userId = await newUser();
    const session = await seedScorableSession(userId);
    const competitor = new PrismaClient();
    try {
      // 外层评分实现被调用时，模拟并发另一方已抢先完成评分
      const racing = async (input: RubricScoringInput): Promise<RubricScoringOutput> => {
        await scoreSession(competitor, session.id, userId, {
          scoreWithRubric: fakeScorer({ 用户理解: 55 }),
        });
        return fakeScorer({ 用户理解: 99 })(input);
      };

      const result = await scoreSession(prisma, session.id, userId, {
        scoreWithRubric: racing,
      });

      expect(result.state).toBe("scored");
      // 落库与返回的都是抢先一方的四元组，未被外层覆盖
      expect(result.scores.find((s) => s.dimension === "用户理解")?.rawScore).toBe(55);
      expect(await prisma.score.count({ where: { sessionId: session.id } })).toBe(3);
      expect(await prisma.sessionFeedback.count({ where: { sessionId: session.id } })).toBe(1);
    } finally {
      await competitor.$disconnect();
    }
  });

  it("落库事务内失败（反馈主键冲突）：整体回滚并向上抛错，状态与四元组不留半截", async () => {
    const userId = await newUser();
    const session = await seedScorableSession(userId);
    // 预先制造 session_feedback 主键冲突：无 scores（幂等检查放行），但反馈已占位
    await prisma.sessionFeedback.create({
      data: { sessionId: session.id, topIssueText: "占位", nextFocusText: "占位" },
    });

    await expect(
      scoreSession(prisma, session.id, userId, { scoreWithRubric: fakeScorer({}) }),
    ).rejects.toThrow();

    const fresh = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(fresh.state).toBe("followup"); // 事务回滚，状态未推进
    expect(await prisma.score.count({ where: { sessionId: session.id } })).toBe(0);
    const profile = await prisma.abilityProfile.count({ where: { userId } });
    expect(profile).toBe(0); // 画像也未写入
  });

  it("题目 Rubric 与能力标签不匹配（数据异常）：快速失败 QUESTION_RUBRIC_INVALID", async () => {
    // 防御性分支：导入管线已校验二者一一对应，此处直接写库构造异常数据
    const broken = await prisma.question.create({
      data: {
        caseTitle: "Rubric 异常测试题",
        caseBackground: { product: "x" },
        mainQuestion: "x？",
        abilityTags: ["用户理解"],
        difficulty: 2,
        rubric: { dimensions: { 根因分析: ["a", "b", "c"] }, forbidden_leaks: ["x"] },
        hintTree: [1, 2, 3, 4, 5].map((level) => ({
          level,
          stage: `s${level}`,
          question: `q${level}`,
        })),
        materials: { core: [], extended: [] },
        status: "draft",
      },
    });
    const userId = await newUser();
    const session = await prisma.trainingSession.create({
      data: {
        userId,
        questionId: broken.id,
        date: new Date(Date.UTC(2026, 9, 3)),
        state: "followup",
        firstAnswer: "首答",
        firstSubmittedAt: new Date(),
        finalAnswer: "终答",
        finalSubmittedAt: new Date(),
      },
    });

    await expect(
      scoreSession(prisma, session.id, userId, { scoreWithRubric: fakeScorer({}) }),
    ).rejects.toMatchObject({ code: CODES.QUESTION_RUBRIC_INVALID });

    await prisma.trainingSession.delete({ where: { id: session.id } });
    await prisma.question.delete({ where: { id: broken.id } });
  });
});

describe("scoreSession：前置守卫", () => {
  it("他人会话：按不存在处理（不泄露存在性）", async () => {
    const ownerId = await newUser();
    const strangerId = await newUser();
    const session = await seedScorableSession(ownerId);
    await expect(
      scoreSession(prisma, session.id, strangerId, { scoreWithRubric: fakeScorer({}) }),
    ).rejects.toMatchObject({ code: CODES.SESSION_NOT_FOUND });
  });

  it("未提交终答：拒绝评分（FINAL_ANSWER_REQUIRED）", async () => {
    const userId = await newUser();
    const session = await seedScorableSession(userId, {
      finalAnswer: null,
      finalSubmittedAt: null,
    });
    await expect(
      scoreSession(prisma, session.id, userId, { scoreWithRubric: fakeScorer({}) }),
    ).rejects.toMatchObject({ code: CODES.FINAL_ANSWER_REQUIRED });
  });

  it("作答流程未走完（reading/answering）：拒绝评分（SESSION_STATE_INVALID）", async () => {
    const userId = await newUser();
    const session = await seedScorableSession(userId, {
      state: "reading",
      finalAnswer: null,
      finalSubmittedAt: null,
    });
    await expect(
      scoreSession(prisma, session.id, userId, { scoreWithRubric: fakeScorer({}) }),
    ).rejects.toMatchObject({ code: CODES.SESSION_STATE_INVALID });
  });
});
