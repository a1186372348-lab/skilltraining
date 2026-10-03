import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SCORING_ERROR_CODES as CODES } from "@/server/modules/scoring/errors";
import type { RubricScoringInput, RubricScoringOutput } from "@/server/modules/scoring/rubric-scorer";
import { scoreSession } from "@/server/modules/scoring/service";

import { submitFeedbackSurvey } from "./survey";
import { getFeedbackView } from "./view";

// 反馈视图装配集成测试：真实数据库，AI 评分以注入假实现 mock（真实冒烟 0 次）。
// 覆盖：懒触发（未评分 → scoring + 后台评分）、进行中去重（重复调用不重复触发 AI）、
// 幂等（已评分直接返回既有结果）、四元组装配正确性、评分失败可安全重试、状态/归属守卫。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

// 与 training/scoring 模块测试共用的上架种子题（upsert 保证跨文件并发播种一致）
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

async function ensureSeedQuestion(): Promise<void> {
  const { id, ...data } = SEED_QUESTION_DATA;
  try {
    await prisma.question.upsert({ where: { id }, create: SEED_QUESTION_DATA, update: data });
  } catch {
    // 并发播种冲突：忽略
  }
}

async function newUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `t07-view-${randomUUID()}@example.com` },
  });
  createdUserIds.push(user.id);
  return user.id;
}

/** 造一个待评分会话（终答已提交，状态 followup） */
async function seedScorableSession(
  userId: string,
  overrides: Partial<{
    state: "reading" | "answering" | "followup" | "scored";
    hintCount: number;
    finalAnswer: string | null;
    finalSubmittedAt: Date | null;
  }> = {},
): Promise<string> {
  const session = await prisma.trainingSession.create({
    data: {
      userId,
      questionId: SEED_QUESTION_ID,
      date: new Date(Date.UTC(2026, 9, 3)),
      state: overrides.state ?? "followup",
      hintCount: overrides.hintCount ?? 0,
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
  return session.id;
}

/** 构造 mock 评分输出（与 T06 测试同款：按维度给分 + 具体诊断） */
function buildScoringOutput(
  input: RubricScoringInput,
  rawScores: Record<string, number>,
): RubricScoringOutput {
  return {
    dimensions: Object.keys(input.rubricDimensions).map((dimension) => ({
      dimension,
      rawScore: rawScores[dimension] ?? 70,
      diagnosis: `${dimension}诊断：引用了终答中的具体证据。`,
    })),
    topIssue: "终答中「效率更高」的断言缺少衡量口径，应补充具体指标。",
    nextFocus: "下一步练「产品价值判断」中的价值量化类问题。",
  };
}

/** 立即返回的 fast scorer */
function fastScorer(rawScores: Record<string, number>, tracker?: { calls: number }) {
  return async (input: RubricScoringInput): Promise<RubricScoringOutput> => {
    if (tracker) tracker.calls += 1;
    return buildScoringOutput(input, rawScores);
  };
}

/** 闸门 scorer：评分调用挂起，直到测试手动放行（用于确定性验证"进行中不重复触发"） */
function gatedScorer(rawScores: Record<string, number>) {
  const calls: RubricScoringInput[] = [];
  let release: (() => void) | null = null;
  const scorer = (input: RubricScoringInput): Promise<RubricScoringOutput> => {
    calls.push(input);
    return new Promise<RubricScoringOutput>((resolve) => {
      release = () => resolve(buildScoringOutput(input, rawScores));
    });
  };
  return { scorer, calls, release: () => release?.() };
}

/** 轮询等待条件成立（后台评分是异步的） */
async function eventually(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("eventually 等待超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForScores(sessionId: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    const count = await prisma.score.count({ where: { sessionId } });
    if (count > 0) return;
    if (Date.now() - start > 3000) throw new Error("等待评分落库超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(ensureSeedQuestion);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("getFeedbackView 懒触发与进行中状态", () => {
  it("未评分会话：返回 scoring 并后台触发评分；进行中重复调用不重复触发 AI；完成后返回 ready", async () => {
    const userId = await newUser();
    const sessionId = await seedScorableSession(userId);
    const gated = gatedScorer({ 用户理解: 88 });

    try {
      const v1 = await getFeedbackView(prisma, sessionId, userId, {
        scoreWithRubric: gated.scorer,
      });
      expect(v1).toEqual({ status: "scoring", sessionId });

      // 后台评分已进入 AI 调用（被闸门挂起）
      await eventually(() => gated.calls.length === 1);

      // 进行中重复调用：仍返回 scoring，不重复触发 AI（懒触发幂等）
      const v2 = await getFeedbackView(prisma, sessionId, userId, {
        scoreWithRubric: gated.scorer,
      });
      expect(v2.status).toBe("scoring");
      expect(gated.calls).toHaveLength(1);

      // 放行 → 评分落库 → 后续调用返回 ready
      gated.release();
      await waitForScores(sessionId);
      const v3 = await getFeedbackView(prisma, sessionId, userId, {
        scoreWithRubric: gated.scorer,
      });
      expect(v3.status).toBe("ready");
      expect(gated.calls).toHaveLength(1); // ready 路径不再调 AI
    } finally {
      gated.release(); // 兜底放行，避免悬挂 Promise
    }
  });

  it("评分 AI 失败：不落任何数据，进行中标记释放后可安全重试", async () => {
    const userId = await newUser();
    const sessionId = await seedScorableSession(userId);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let rejectCalls = 0;
    const rejectingScorer = (): Promise<RubricScoringOutput> => {
      rejectCalls += 1;
      return Promise.reject(new Error("模拟 AI 网关故障"));
    };
    let successCalls = 0;
    const successScorer = (input: RubricScoringInput): Promise<RubricScoringOutput> => {
      successCalls += 1;
      return Promise.resolve(buildScoringOutput(input, { 用户理解: 80 }));
    };

    try {
      const v1 = await getFeedbackView(prisma, sessionId, userId, {
        scoreWithRubric: rejectingScorer,
      });
      expect(v1.status).toBe("scoring");
      await eventually(() => rejectCalls === 1);
      await eventually(() => consoleSpy.mock.calls.length >= 1); // 失败已记录日志

      // 失败不落库
      expect(await prisma.score.count({ where: { sessionId } })).toBe(0);

      // 进行中标记释放后，下一次轮询可重新触发（用成功 scorer 轮询直到触发）
      let retriggered = false;
      for (let i = 0; i < 100 && !retriggered; i += 1) {
        await getFeedbackView(prisma, sessionId, userId, { scoreWithRubric: successScorer });
        retriggered = successCalls === 1;
        if (!retriggered) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(retriggered).toBe(true);
      expect(successCalls).toBe(1);

      await waitForScores(sessionId);
      const ready = await getFeedbackView(prisma, sessionId, userId, {
        scoreWithRubric: successScorer,
      });
      expect(ready.status).toBe("ready");
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("getFeedbackView 视图装配（四元组 / BR-7 反馈文本）", () => {
  it("四元组正确：有效分 = 原始分 × 系数（BR-1/BR-2），顺序与能力标签一致", async () => {
    const userId = await newUser();
    const sessionId = await seedScorableSession(userId, { hintCount: 2 }); // 系数 0.8
    const tracker = { calls: 0 };
    const scorer = fastScorer({ 用户理解: 85, 产品价值判断: 90, 产品取舍: 70 }, tracker);

    const scoring = await getFeedbackView(prisma, sessionId, userId, { scoreWithRubric: scorer });
    expect(scoring.status).toBe("scoring");
    await waitForScores(sessionId);

    const view = await getFeedbackView(prisma, sessionId, userId, { scoreWithRubric: scorer });
    expect(view.status).toBe("ready");
    if (view.status !== "ready") return;

    expect(view.sessionId).toBe(sessionId);
    expect(view.scores.map((s) => s.dimension)).toEqual(SEED_DIMENSIONS);
    expect(view.scores[0]).toEqual({
      dimension: "用户理解",
      rawScore: 85,
      hintCount: 2,
      coefficient: 0.8,
      effectiveScore: 68, // 85 × 0.8
      diagnosisText: "用户理解诊断：引用了终答中的具体证据。",
    });
    expect(view.scores[1]?.effectiveScore).toBe(72); // 90 × 0.8
    expect(view.scores[2]?.effectiveScore).toBe(56); // 70 × 0.8
    expect(view.scores.every((s) => s.hintCount === 2 && s.coefficient === 0.8)).toBe(true);

    // BR-7：最需优化问题与下一步方向透传
    expect(view.topIssueText).toBe("终答中「效率更高」的断言缺少衡量口径，应补充具体指标。");
    expect(view.nextFocusText).toBe("下一步练「产品价值判断」中的价值量化类问题。");

    // 问卷状态：未提交；仅 1 次已评分训练，不触发第三问
    expect(view.survey).toEqual({ submitted: false, needsPeriodicQ3: false });
    expect(tracker.calls).toBe(1); // 全程只调一次 AI
  });

  it("幂等：已评分会话重复调用直接返回既有结果，不再触发 AI", async () => {
    const userId = await newUser();
    const sessionId = await seedScorableSession(userId);
    // 先经 T06 公开入口完成评分
    await scoreSession(prisma, sessionId, userId, {
      scoreWithRubric: fastScorer({ 用户理解: 90 }),
    });

    const spy = { calls: 0 };
    const deps = { scoreWithRubric: fastScorer({ 用户理解: 1 }, spy) };
    const v1 = await getFeedbackView(prisma, sessionId, userId, deps);
    const v2 = await getFeedbackView(prisma, sessionId, userId, deps);
    expect(v1.status).toBe("ready");
    expect(v2.status).toBe("ready");
    expect(v1).toEqual(v2);
    expect(spy.calls).toBe(0); // 重复读取不触发 AI
    if (v1.status === "ready") {
      expect(v1.scores[0]?.rawScore).toBe(90); // 既有结果不被新 deps 影响
    }
  });

  it("问卷提交后：ready 视图 survey.submitted=true", async () => {
    const userId = await newUser();
    const sessionId = await seedScorableSession(userId);
    await scoreSession(prisma, sessionId, userId, {
      scoreWithRubric: fastScorer({}),
    });
    await submitFeedbackSurvey(prisma, sessionId, userId, { q1Clarity: 5, q2Next: 4 });

    const view = await getFeedbackView(prisma, sessionId, userId, {
      scoreWithRubric: fastScorer({}),
    });
    expect(view.status).toBe("ready");
    if (view.status === "ready") {
      expect(view.survey.submitted).toBe(true);
      expect(view.survey.needsPeriodicQ3).toBe(false);
    }
  });
});

describe("getFeedbackView 状态与归属守卫", () => {
  it("reading/answering 状态：409 SESSION_STATE_INVALID（作答流程未走完）", async () => {
    const userId = await newUser();
    const readingId = await seedScorableSession(userId, {
      state: "reading",
      finalAnswer: null,
      finalSubmittedAt: null,
    });
    const answeringId = await seedScorableSession(userId, {
      state: "answering",
      finalAnswer: null,
      finalSubmittedAt: null,
    });
    await expect(getFeedbackView(prisma, readingId, userId)).rejects.toMatchObject({
      code: CODES.SESSION_STATE_INVALID,
      httpStatus: 409,
    });
    await expect(getFeedbackView(prisma, answeringId, userId)).rejects.toMatchObject({
      code: CODES.SESSION_STATE_INVALID,
      httpStatus: 409,
    });
  });

  it("followup 但未提交终答：409 FINAL_ANSWER_REQUIRED", async () => {
    const userId = await newUser();
    const sessionId = await seedScorableSession(userId, {
      finalAnswer: null,
      finalSubmittedAt: null,
    });
    await expect(getFeedbackView(prisma, sessionId, userId)).rejects.toMatchObject({
      code: CODES.FINAL_ANSWER_REQUIRED,
      httpStatus: 409,
    });
  });

  it("不存在或他人会话：404 SESSION_NOT_FOUND（不泄露存在性）", async () => {
    const userId = await newUser();
    const otherUserId = await newUser();
    const sessionId = await seedScorableSession(otherUserId);
    await expect(getFeedbackView(prisma, sessionId, userId)).rejects.toMatchObject({
      code: CODES.SESSION_NOT_FOUND,
      httpStatus: 404,
    });
    await expect(getFeedbackView(prisma, randomUUID(), userId)).rejects.toMatchObject({
      code: CODES.SESSION_NOT_FOUND,
      httpStatus: 404,
    });
  });
});
