import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SCORING_ERROR_CODES as CODES, ScoringError } from "@/server/modules/scoring/errors";

import {
  PERIODIC_SURVEY_INTERVAL,
  getSurveyStatus,
  needsPeriodicQuestion,
  submitFeedbackSurvey,
} from "./survey";

// 感知问卷模块集成测试：真实数据库（docker PostgreSQL:5433）。
// 覆盖：D16 周期性一问计数（4 次不出/第 5 次出）、落库、幂等（重复提交不覆盖不重复落库）、
// 未评分会话 409、他人会话 404、非触发周期携带第三问不落库。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

// 与 training/scoring 模块测试共用的上架种子题（upsert 保证跨文件并发播种一致）
const SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000a1";

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
    // 并发播种冲突：忽略
  }
}

async function newUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `t07-survey-${randomUUID()}@example.com` },
  });
  createdUserIds.push(user.id);
  return user.id;
}

/** 造一个已评分会话（问卷挂载的目标会话） */
async function seedScoredSession(userId: string): Promise<string> {
  const session = await prisma.trainingSession.create({
    data: {
      userId,
      questionId: SEED_QUESTION_ID,
      date: new Date(Date.UTC(2026, 9, 3)),
      state: "scored",
      scoredAt: new Date(),
    },
  });
  return session.id;
}

beforeAll(ensureSeedQuestion);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("needsPeriodicQuestion（D16：每 5 次已评分训练触发周期性一问）", () => {
  it("0/1/4 次不触发，第 5 次触发", () => {
    expect(needsPeriodicQuestion(0)).toBe(false);
    expect(needsPeriodicQuestion(1)).toBe(false);
    expect(needsPeriodicQuestion(4)).toBe(false);
    expect(needsPeriodicQuestion(5)).toBe(true);
  });

  it("仅 5 的整数倍触发：6/9 不出，10 出", () => {
    expect(needsPeriodicQuestion(6)).toBe(false);
    expect(needsPeriodicQuestion(9)).toBe(false);
    expect(needsPeriodicQuestion(10)).toBe(true);
    expect(PERIODIC_SURVEY_INTERVAL).toBe(5);
  });

  it("非法输入（负数/NaN/小数）按不触发处理", () => {
    expect(needsPeriodicQuestion(-5)).toBe(false);
    expect(needsPeriodicQuestion(Number.NaN)).toBe(false);
    expect(needsPeriodicQuestion(2.5)).toBe(false);
  });
});

describe("submitFeedbackSurvey 落库与幂等", () => {
  it("首次提交：两问落库 feedback_surveys，created=true，第三问未触发", async () => {
    const userId = await newUser();
    const sessionId = await seedScoredSession(userId); // 该用户第 1 次已评分训练
    const result = await submitFeedbackSurvey(prisma, sessionId, userId, {
      q1Clarity: 4,
      q2Next: 5,
    });
    expect(result.created).toBe(true);
    expect(result.q1Clarity).toBe(4);
    expect(result.q2Next).toBe(5);
    expect(result.periodicQ3).toBeNull();
    expect(result.needsPeriodicQ3).toBe(false);

    const row = await prisma.feedbackSurvey.findUniqueOrThrow({ where: { sessionId } });
    expect(row.q1Clarity).toBe(4);
    expect(row.q2Next).toBe(5);
    expect(row.periodicQ3).toBeNull();
  });

  it("幂等：同会话重复提交不覆盖、不重复落库，created=false", async () => {
    const userId = await newUser();
    const sessionId = await seedScoredSession(userId);
    await submitFeedbackSurvey(prisma, sessionId, userId, { q1Clarity: 4, q2Next: 4 });

    const again = await submitFeedbackSurvey(prisma, sessionId, userId, {
      q1Clarity: 1,
      q2Next: 1,
    });
    expect(again.created).toBe(false);
    expect(again.q1Clarity).toBe(4);
    expect(again.q2Next).toBe(4);

    const rows = await prisma.feedbackSurvey.findMany({ where: { sessionId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.q1Clarity).toBe(4);
  });

  it("第 4 次已评分训练：不触发第三问，即使携带 periodicQ3 也不落库", async () => {
    const userId = await newUser();
    await seedScoredSession(userId);
    await seedScoredSession(userId);
    await seedScoredSession(userId);
    const sessionId = await seedScoredSession(userId); // 第 4 次

    const result = await submitFeedbackSurvey(prisma, sessionId, userId, {
      q1Clarity: 5,
      q2Next: 5,
      periodicQ3: 5, // 非触发周期：服务端应忽略
    });
    expect(result.needsPeriodicQ3).toBe(false);
    expect(result.periodicQ3).toBeNull();

    const row = await prisma.feedbackSurvey.findUniqueOrThrow({ where: { sessionId } });
    expect(row.periodicQ3).toBeNull();
  });

  it("第 5 次已评分训练：触发第三问，periodicQ3 落库", async () => {
    const userId = await newUser();
    for (let i = 0; i < 4; i += 1) await seedScoredSession(userId);
    const sessionId = await seedScoredSession(userId); // 第 5 次

    const result = await submitFeedbackSurvey(prisma, sessionId, userId, {
      q1Clarity: 4,
      q2Next: 4,
      periodicQ3: 3,
    });
    expect(result.needsPeriodicQ3).toBe(true);
    expect(result.periodicQ3).toBe(3);

    const row = await prisma.feedbackSurvey.findUniqueOrThrow({ where: { sessionId } });
    expect(row.periodicQ3).toBe(3);
  });

  it("触发第三问但未作答：periodicQ3 落库为 null（契约允许 nullable）", async () => {
    const userId = await newUser();
    for (let i = 0; i < 4; i += 1) await seedScoredSession(userId);
    const sessionId = await seedScoredSession(userId); // 第 5 次

    const result = await submitFeedbackSurvey(prisma, sessionId, userId, {
      q1Clarity: 3,
      q2Next: 3,
    });
    expect(result.needsPeriodicQ3).toBe(true);
    expect(result.periodicQ3).toBeNull();
  });

  it("未评分会话（followup）：409 SESSION_STATE_INVALID", async () => {
    const userId = await newUser();
    const session = await prisma.trainingSession.create({
      data: {
        userId,
        questionId: SEED_QUESTION_ID,
        date: new Date(Date.UTC(2026, 9, 3)),
        state: "followup",
      },
    });
    await expect(
      submitFeedbackSurvey(prisma, session.id, userId, { q1Clarity: 4, q2Next: 4 }),
    ).rejects.toMatchObject({
      name: "ScoringError",
      code: CODES.SESSION_STATE_INVALID,
      httpStatus: 409,
    });
  });

  it("不存在或他人会话：404 SESSION_NOT_FOUND（不泄露存在性）", async () => {
    const userId = await newUser();
    const otherUserId = await newUser();
    const sessionId = await seedScoredSession(otherUserId);

    await expect(
      submitFeedbackSurvey(prisma, sessionId, userId, { q1Clarity: 4, q2Next: 4 }),
    ).rejects.toMatchObject({ code: CODES.SESSION_NOT_FOUND, httpStatus: 404 });
    await expect(
      submitFeedbackSurvey(prisma, randomUUID(), userId, { q1Clarity: 4, q2Next: 4 }),
    ).rejects.toBeInstanceOf(ScoringError);
  });
});

describe("getSurveyStatus（反馈视图装配用）", () => {
  it("未提交：submitted=false；按 scored 计数给出 needsPeriodicQ3", async () => {
    const userId = await newUser();
    const sessionId = await seedScoredSession(userId); // 1 次：不触发
    const status = await getSurveyStatus(prisma, sessionId, userId);
    expect(status).toEqual({ submitted: false, needsPeriodicQ3: false });
  });

  it("已提交：submitted=true", async () => {
    const userId = await newUser();
    const sessionId = await seedScoredSession(userId);
    await submitFeedbackSurvey(prisma, sessionId, userId, { q1Clarity: 5, q2Next: 5 });
    const status = await getSurveyStatus(prisma, sessionId, userId);
    expect(status.submitted).toBe(true);
  });

  it("第 5 次已评分训练：needsPeriodicQ3=true", async () => {
    const userId = await newUser();
    for (let i = 0; i < 4; i += 1) await seedScoredSession(userId);
    const sessionId = await seedScoredSession(userId); // 第 5 次
    const status = await getSurveyStatus(prisma, sessionId, userId);
    expect(status.needsPeriodicQ3).toBe(true);
  });
});
