import { randomUUID } from "node:crypto";

import { PrismaClient, type Question } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TRAINING_ERROR_CODES as CODES, TrainingError } from "./errors";
import {
  getOrCreateTodaySession,
  requestHint,
  submitFinalAnswer,
  submitFirstAnswer,
} from "./service";

// 训练会话服务集成测试：打真实数据库（docker PostgreSQL:5433），AI 追问以注入假实现 mock。
// T11 自适应选题已接入：播种时先把其他上架题归档，保证选题确定命中本文件的种子题。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

// 上架种子题（多个测试文件共用同一 id）：播种时归档其他上架题，自适应选题确定命中本题
const SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000a1";

const seedHintTree = [1, 2, 3, 4, 5].map((level) => ({
  level,
  stage: `阶段${level}`,
  question: `第${level}层提示`,
}));

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
  hintTree: seedHintTree,
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
    // 共享开发库已导入真实上架题：先下架本种子外的全部上架题，选题结果才确定命中本种子
    await prisma.question.updateMany({
      where: { status: "published", id: { not: id } },
      data: { status: "archived" },
    });
    return await prisma.question.upsert({ where: { id }, create: SEED_QUESTION_DATA, update: data });
  } catch {
    // 并发测试文件同时播种：冲突时直接读取
    return prisma.question.findUniqueOrThrow({ where: { id: SEED_QUESTION_ID } });
  }
}

async function newUser(): Promise<string> {
  const email = `t05-service-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email } });
  createdUserIds.push(user.id);
  return user.id;
}

/** 直接造一个处于指定状态的会话（绕过前置流程，聚焦被测分支） */
async function seedSession(
  userId: string,
  overrides: Partial<{
    state: "reading" | "answering" | "followup" | "scored";
    hintCount: number;
    firstAnswer: string;
    firstSubmittedAt: Date;
    finalAnswer: string;
    finalSubmittedAt: Date;
    followups: { round: number; question: string }[];
  }> = {},
) {
  return prisma.trainingSession.create({
    data: {
      userId,
      questionId: SEED_QUESTION_ID,
      date: new Date(Date.UTC(2026, 9, 3)),
      state: overrides.state ?? "reading",
      hintCount: overrides.hintCount ?? 0,
      firstAnswer: overrides.firstAnswer ?? null,
      firstSubmittedAt: overrides.firstSubmittedAt ?? null,
      finalAnswer: overrides.finalAnswer ?? null,
      finalSubmittedAt: overrides.finalSubmittedAt ?? null,
      followups: overrides.followups ?? undefined,
    },
  });
}

beforeAll(async () => {
  await ensureSeedQuestion();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }); // 级联清理会话与提示事件
  await prisma.$disconnect();
});

describe("getOrCreateTodaySession：自适应选题与会话创建", () => {
  it("首次进入：选题命中上架种子题创建会话（reading），当天重复进入复用同一会话", async () => {
    const userId = await newUser();
    const first = await getOrCreateTodaySession(prisma, userId);
    expect(first.session.state).toBe("reading");
    expect(first.session.questionId).toBe(SEED_QUESTION_ID);
    expect(first.question.id).toBe(SEED_QUESTION_ID);

    const second = await getOrCreateTodaySession(prisma, userId);
    expect(second.session.id).toBe(first.session.id);

    const count = await prisma.trainingSession.count({ where: { userId } });
    expect(count).toBe(1);
  });
});

describe("requestHint：5 层逐层释放（D5/BR-3/FR-3）", () => {
  it("逐层释放 1~5 层并写 hint_events，响应携带当前系数；第 6 次拒绝", async () => {
    const userId = await newUser();
    const { session } = await getOrCreateTodaySession(prisma, userId);

    const expectedCoefficients = [0.9, 0.8, 0.7, 0.6, 0.6];
    for (let layer = 1; layer <= 5; layer += 1) {
      const result = await requestHint(prisma, session.id, userId);
      expect(result.hint.level).toBe(layer);
      expect(result.hint.question).toBe(`第${layer}层提示`);
      expect(result.hintCount).toBe(layer);
      expect(result.coefficient).toBe(expectedCoefficients[layer - 1]);
      expect(result.state).toBe("answering");
    }

    await expect(requestHint(prisma, session.id, userId)).rejects.toMatchObject({
      code: CODES.HINTS_EXHAUSTED,
    });

    const events = await prisma.hintEvent.findMany({
      where: { sessionId: session.id },
      orderBy: { layer: "asc" },
    });
    expect(events.map((e) => e.layer)).toEqual([1, 2, 3, 4, 5]);
  });

  it("首次提交后请求提示：拒绝（D7）", async () => {
    const userId = await newUser();
    const session = await seedSession(userId, {
      state: "followup",
      firstAnswer: "首答",
      firstSubmittedAt: new Date(),
    });
    await expect(requestHint(prisma, session.id, userId)).rejects.toMatchObject({
      code: CODES.HINT_DISABLED,
    });
  });

  it("他人会话：按不存在处理（不泄露存在性）", async () => {
    const ownerId = await newUser();
    const strangerId = await newUser();
    const session = await seedSession(ownerId);
    await expect(requestHint(prisma, session.id, strangerId)).rejects.toMatchObject({
      code: CODES.SESSION_NOT_FOUND,
    });
  });

  it("提示树数据异常（缺层）：快速失败报 INVALID_STATE，不空转计数", async () => {
    // 防御性分支：导入管线已校验 5 层，此处构造缺层题验证兜底
    const broken = await prisma.question.create({
      data: {
        caseTitle: "缺层提示树测试题",
        caseBackground: { product: "x" },
        mainQuestion: "x？",
        abilityTags: ["用户理解"],
        difficulty: 2,
        rubric: { dimensions: { 用户理解: ["a", "b", "c"] }, forbidden_leaks: ["x"] },
        hintTree: [1, 2, 3, 4].map((level) => ({ level, stage: `s${level}`, question: `q${level}` })),
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
        state: "answering",
        hintCount: 4,
      },
    });
    await expect(requestHint(prisma, session.id, userId)).rejects.toMatchObject({
      code: CODES.INVALID_STATE,
    });
    await prisma.trainingSession.delete({ where: { id: session.id } });
    await prisma.question.delete({ where: { id: broken.id } });
  });
});

describe("submitFirstAnswer：状态推进 + AI 追问（BR-4/FR-4）", () => {
  it("首答落库、状态推进 followup、追问（1~2 轮）存入 followups jsonb；提示随之禁用", async () => {
    const userId = await newUser();
    const { session } = await getOrCreateTodaySession(prisma, userId);
    const generateFollowups = async () => ["你的证据是什么？", "反方如何反驳？"];

    const result = await submitFirstAnswer(prisma, session.id, userId, "我的首次答案", {
      generateFollowups,
    });

    expect(result.state).toBe("followup");
    expect(result.followups).toEqual(["你的证据是什么？", "反方如何反驳？"]);
    expect(result.coefficient).toBe(1.0);

    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.firstAnswer).toBe("我的首次答案");
    expect(row.firstSubmittedAt).not.toBeNull();
    expect(row.state).toBe("followup");
    expect(row.followups).toEqual([
      { round: 1, question: "你的证据是什么？" },
      { round: 2, question: "反方如何反驳？" },
    ]);

    await expect(requestHint(prisma, session.id, userId)).rejects.toMatchObject({
      code: CODES.HINT_DISABLED,
    });
  });

  it("幂等：重复提交不覆盖首答、不重复生成追问", async () => {
    const userId = await newUser();
    const session = await seedSession(userId);
    let calls = 0;
    const generateFollowups = async () => {
      calls += 1;
      return ["追问一"];
    };

    const first = await submitFirstAnswer(prisma, session.id, userId, "原始首答", { generateFollowups });
    const second = await submitFirstAnswer(prisma, session.id, userId, "被篡改的首答", {
      generateFollowups,
    });

    expect(calls).toBe(1); // AI 未被重复调用
    expect(second.followups).toEqual(first.followups);
    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.firstAnswer).toBe("原始首答");
  });

  it("AI 追问失败：不阻塞训练，状态照推进、followups 为空（失败计入日志）", async () => {
    const userId = await newUser();
    const session = await seedSession(userId);
    const generateFollowups = async (): Promise<string[]> => {
      throw new Error("网关不可用");
    };

    const result = await submitFirstAnswer(prisma, session.id, userId, "首答", { generateFollowups });
    expect(result.state).toBe("followup");
    expect(result.followups).toEqual([]);

    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.state).toBe("followup");
    expect(row.followups).toEqual([]);
  });
});

describe("submitFinalAnswer：终答落库与幂等", () => {
  it("终答 + 时间戳落库，状态保持 followup（scored 由 T06 写入）", async () => {
    const userId = await newUser();
    const session = await seedSession(userId, {
      state: "followup",
      firstAnswer: "首答",
      firstSubmittedAt: new Date(),
    });

    const result = await submitFinalAnswer(prisma, session.id, userId, "我的最终答案");
    expect(result.state).toBe("followup");
    expect(result.finalSubmittedAt).not.toBeNull();

    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.finalAnswer).toBe("我的最终答案");
    expect(row.state).toBe("followup");
  });

  it("幂等：重复提交终答不覆盖、不重复推进", async () => {
    const userId = await newUser();
    const session = await seedSession(userId, {
      state: "followup",
      firstAnswer: "首答",
      firstSubmittedAt: new Date(),
    });

    const first = await submitFinalAnswer(prisma, session.id, userId, "原始终答");
    const second = await submitFinalAnswer(prisma, session.id, userId, "被篡改的终答");

    expect(second.finalSubmittedAt?.getTime()).toBe(first.finalSubmittedAt?.getTime());
    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.finalAnswer).toBe("原始终答");
  });

  it("未提交首答直接终答：拒绝", async () => {
    const userId = await newUser();
    const session = await seedSession(userId);
    await expect(submitFinalAnswer(prisma, session.id, userId, "终答")).rejects.toMatchObject({
      code: CODES.FIRST_ANSWER_REQUIRED,
    });
  });

  it("他人会话：按不存在处理", async () => {
    const ownerId = await newUser();
    const strangerId = await newUser();
    const session = await seedSession(ownerId, {
      state: "followup",
      firstAnswer: "首答",
      firstSubmittedAt: new Date(),
    });
    await expect(submitFinalAnswer(prisma, session.id, strangerId, "终答")).rejects.toMatchObject({
      code: CODES.SESSION_NOT_FOUND,
    });
    await expect(submitFirstAnswer(prisma, session.id, strangerId, "首答")).rejects.toMatchObject({
      code: CODES.SESSION_NOT_FOUND,
    });
  });
});

describe("错误类型", () => {
  it("TrainingError 携带 code 与 httpStatus", () => {
    const error = new TrainingError(CODES.SESSION_NOT_FOUND, 404, "不存在");
    expect(error).toBeInstanceOf(Error);
    expect(error.httpStatus).toBe(404);
  });
});
