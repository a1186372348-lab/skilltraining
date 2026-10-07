import { randomUUID } from "node:crypto";

import { PrismaClient, type Question } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TRAINING_ERROR_CODES as CODES, TrainingError } from "./errors";
import {
  getLatestDailySession,
  getOrCreateExtraSession,
  getOrCreateTodaySession,
  requestFollowupHint,
  requestHint,
  submitFinalAnswer,
  submitFirstAnswer,
  todayUtc,
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
    followupHintCount: number;
    firstAnswer: string;
    firstSubmittedAt: Date;
    finalAnswer: string;
    finalSubmittedAt: Date;
    followups: { round: number; question: string; hint?: string; hintReleased?: boolean }[];
  }> = {},
) {
  return prisma.trainingSession.create({
    data: {
      userId,
      questionId: SEED_QUESTION_ID,
      date: new Date(Date.UTC(2026, 9, 3)),
      state: overrides.state ?? "reading",
      hintCount: overrides.hintCount ?? 0,
      followupHintCount: overrides.followupHintCount ?? 0,
      firstAnswer: overrides.firstAnswer ?? null,
      firstSubmittedAt: overrides.firstSubmittedAt ?? null,
      finalAnswer: overrides.finalAnswer ?? null,
      finalSubmittedAt: overrides.finalSubmittedAt ?? null,
      followups: overrides.followups ?? undefined,
    },
  });
}

// T21 加练链路专用：第二道上架种子题（验证「终答后再练选下一道不同题」）与基线题（kind 过滤验证）
const EXTRA_SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000a2";
const BASELINE_KIND_QUESTION_ID = "00000000-0000-4000-8000-0000000000b1";

/** 第二道上架种子题入池（tags/难度与 a1 一致，排序只看 id 升序；afterAll 统一清理） */
async function ensureExtraSeedQuestion(): Promise<void> {
  const data = { ...SEED_QUESTION_DATA, id: EXTRA_SEED_QUESTION_ID, caseTitle: "T21 加练第二种子题" };
  const { id, ...rest } = data;
  await prisma.question.upsert({ where: { id }, create: data, update: rest });
}

/** 基线题（kind=baseline；draft 状态双保险不入日常选题池，仅作会话关联） */
async function ensureBaselineKindQuestion(): Promise<void> {
  const data = {
    ...SEED_QUESTION_DATA,
    id: BASELINE_KIND_QUESTION_ID,
    caseTitle: "T21 基线题（排除验证用）",
    status: "draft" as const,
    kind: "baseline" as const,
  };
  const { id, ...rest } = data;
  await prisma.question.upsert({ where: { id }, create: data, update: rest });
}

/** 造一个归属于今天的会话（T21 加练链路用；与 seedSession 的固定历史日期区分） */
async function seedTodaySession(
  userId: string,
  overrides: Partial<{
    questionId: string;
    isExtra: boolean;
    state: "reading" | "answering" | "followup" | "scored";
    finalAnswer: string;
    finalSubmittedAt: Date;
    startedAt: Date;
  }> = {},
) {
  return prisma.trainingSession.create({
    data: {
      userId,
      questionId: overrides.questionId ?? SEED_QUESTION_ID,
      date: todayUtc(),
      isExtra: overrides.isExtra ?? false,
      state: overrides.state ?? "reading",
      finalAnswer: overrides.finalAnswer ?? null,
      finalSubmittedAt: overrides.finalSubmittedAt ?? null,
      startedAt: overrides.startedAt ?? new Date(),
    },
  });
}

beforeAll(async () => {
  await ensureSeedQuestion();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }); // 级联清理会话与提示事件
  // T21 第二种子题恢复为归档（不删除：并行文件的会话可能引用它，删除会触发外键冲突；
  // 与共享种子题 a1 同一处置——留库、下次 upsert 复用）
  await prisma.question.updateMany({
    where: { id: EXTRA_SEED_QUESTION_ID },
    data: { status: "archived" },
  });
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

describe("submitFirstAnswer：状态推进 + AI 追问（BR-4/FR-4/D22）", () => {
  it("首答落库、状态推进 followup、追问（1~2 轮，含预生成提示）存入 followups jsonb；提示随之禁用", async () => {
    const userId = await newUser();
    const { session } = await getOrCreateTodaySession(prisma, userId);
    const generateFollowups = async () => [
      { question: "你的证据是什么？", hint: "想想可衡量的指标" },
      { question: "反方如何反驳？", hint: "站在反方立场找论据" },
    ];

    const result = await submitFirstAnswer(prisma, session.id, userId, "我的首次答案", {
      generateFollowups,
    });

    expect(result.state).toBe("followup");
    expect(result.followups).toEqual([
      { round: 1, question: "你的证据是什么？", hasHint: true, hintReleased: false, hint: null },
      { round: 2, question: "反方如何反驳？", hasHint: true, hintReleased: false, hint: null },
    ]);
    expect(result.coefficient).toBe(1.0);

    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.firstAnswer).toBe("我的首次答案");
    expect(row.firstSubmittedAt).not.toBeNull();
    expect(row.state).toBe("followup");
    // 预生成提示随追问落库（D22：点击时读库零等待），初始未释放
    expect(row.followups).toEqual([
      { round: 1, question: "你的证据是什么？", hint: "想想可衡量的指标", hintReleased: false },
      { round: 2, question: "反方如何反驳？", hint: "站在反方立场找论据", hintReleased: false },
    ]);
    expect(row.followupHintCount).toBe(0);

    await expect(requestHint(prisma, session.id, userId)).rejects.toMatchObject({
      code: CODES.HINT_DISABLED,
    });
  });

  it("AI 未给出提示（hint 空串）：追问保留、按无提示落库", async () => {
    const userId = await newUser();
    const session = await seedSession(userId);
    const generateFollowups = async () => [{ question: "追问一", hint: "" }];

    const result = await submitFirstAnswer(prisma, session.id, userId, "首答", { generateFollowups });
    expect(result.followups).toEqual([
      { round: 1, question: "追问一", hasHint: false, hintReleased: false, hint: null },
    ]);
    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.followups).toEqual([{ round: 1, question: "追问一", hint: "", hintReleased: false }]);
  });

  it("幂等：重复提交不覆盖首答、不重复生成追问", async () => {
    const userId = await newUser();
    const session = await seedSession(userId);
    let calls = 0;
    const generateFollowups = async () => {
      calls += 1;
      return [{ question: "追问一", hint: "提示一" }];
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
    const generateFollowups = async (): Promise<{ question: string; hint: string }[]> => {
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

describe("requestFollowupHint：追问阶段提示释放（T19 / D22 / BR-2 修订）", () => {
  /** 造一个 followup 状态、两轮追问各带预生成提示的会话 */
  async function seedFollowupSession(
    userId: string,
    overrides: Parameters<typeof seedSession>[1] = {},
  ) {
    return seedSession(userId, {
      state: "followup",
      firstAnswer: "首答",
      firstSubmittedAt: new Date(),
      followups: [
        { round: 1, question: "追问一", hint: "追问提示一", hintReleased: false },
        { round: 2, question: "追问二", hint: "追问提示二", hintReleased: false },
      ],
      ...overrides,
    });
  }

  it("成功释放：返回该轮 hint，followupHintCount 自增，系数按组合公式重算", async () => {
    const userId = await newUser();
    const session = await seedFollowupSession(userId, { hintCount: 1 });

    const result = await requestFollowupHint(prisma, session.id, userId, 1);
    expect(result).toEqual({
      round: 1,
      hint: "追问提示一",
      followupHintCount: 1,
      coefficient: 0.85, // max(0.6, 1 − 0.1×1 − 0.05×1)
    });

    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.followupHintCount).toBe(1);
    expect(row.followups).toEqual([
      { round: 1, question: "追问一", hint: "追问提示一", hintReleased: true },
      { round: 2, question: "追问二", hint: "追问提示二", hintReleased: false },
    ]);
  });

  it("幂等：同一 round 重复请求返回同一 hint，不重复计数", async () => {
    const userId = await newUser();
    const session = await seedFollowupSession(userId);

    const first = await requestFollowupHint(prisma, session.id, userId, 1);
    const second = await requestFollowupHint(prisma, session.id, userId, 1);

    expect(second.hint).toBe(first.hint);
    expect(second.followupHintCount).toBe(1); // 未重复计数
    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.followupHintCount).toBe(1);
  });

  it("不同 round 各释放一次：计数 2，系数含两个半价项", async () => {
    const userId = await newUser();
    const session = await seedFollowupSession(userId);

    await requestFollowupHint(prisma, session.id, userId, 1);
    const second = await requestFollowupHint(prisma, session.id, userId, 2);

    expect(second.followupHintCount).toBe(2);
    expect(second.coefficient).toBe(0.9); // max(0.6, 1 − 0.05×2)
  });

  it("并发双击同一 round：只计 1 次（守卫条件原子自增）", async () => {
    const userId = await newUser();
    const session = await seedFollowupSession(userId);

    const [a, b] = await Promise.all([
      requestFollowupHint(prisma, session.id, userId, 1),
      requestFollowupHint(prisma, session.id, userId, 1),
    ]);
    expect(a.hint).toBe("追问提示一");
    expect(b.hint).toBe("追问提示一");
    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.followupHintCount).toBe(1);
  });

  it("round 不存在：404 FOLLOWUP_NOT_FOUND", async () => {
    const userId = await newUser();
    const session = await seedFollowupSession(userId);
    await expect(requestFollowupHint(prisma, session.id, userId, 3)).rejects.toMatchObject({
      code: CODES.FOLLOWUP_NOT_FOUND,
      httpStatus: 404,
    });
  });

  it("该轮无预生成提示（AI 降级/老数据）：409 FOLLOWUP_HINT_NOT_AVAILABLE，不计数", async () => {
    const userId = await newUser();
    const session = await seedFollowupSession(userId, {
      followups: [
        { round: 1, question: "老追问无提示字段" }, // 存量老记录
        { round: 2, question: "降级追问", hint: "", hintReleased: false }, // AI 降级空 hint
      ],
    });
    await expect(requestFollowupHint(prisma, session.id, userId, 1)).rejects.toMatchObject({
      code: CODES.FOLLOWUP_HINT_NOT_AVAILABLE,
    });
    await expect(requestFollowupHint(prisma, session.id, userId, 2)).rejects.toMatchObject({
      code: CODES.FOLLOWUP_HINT_NOT_AVAILABLE,
    });
    const row = await prisma.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.followupHintCount).toBe(0);
  });

  it("越状态：非 followup 状态（reading/scored）409 拒绝", async () => {
    const userId = await newUser();
    const reading = await seedSession(userId, { state: "reading" });
    await expect(requestFollowupHint(prisma, reading.id, userId, 1)).rejects.toMatchObject({
      code: CODES.INVALID_STATE,
      httpStatus: 409,
    });

    const scored = await seedFollowupSession(userId, { state: "scored" });
    await expect(requestFollowupHint(prisma, scored.id, userId, 1)).rejects.toMatchObject({
      code: CODES.INVALID_STATE,
    });
  });

  it("越权：他人会话按不存在处理（404，不泄露存在性）", async () => {
    const ownerId = await newUser();
    const strangerId = await newUser();
    const session = await seedFollowupSession(ownerId);
    await expect(requestFollowupHint(prisma, session.id, strangerId, 1)).rejects.toMatchObject({
      code: CODES.SESSION_NOT_FOUND,
      httpStatus: 404,
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

describe("getOrCreateExtraSession：加练会话创建与幂等（T21 / D3）", () => {
  it("当天无任何会话：经选题引擎新建加练会话（isExtra=true、state=reading、归属今天）", async () => {
    const userId = await newUser();
    const { session, question } = await getOrCreateExtraSession(prisma, userId);

    expect(session.isExtra).toBe(true);
    expect(session.state).toBe("reading");
    expect(session.date).toEqual(todayUtc());
    expect(session.questionId).toBe(SEED_QUESTION_ID);
    expect(question.id).toBe(SEED_QUESTION_ID);
  });

  it("每日一题已终答：新建加练会话", async () => {
    const userId = await newUser();
    const daily = await seedTodaySession(userId, {
      state: "followup",
      finalAnswer: "终答",
      finalSubmittedAt: new Date(),
    });

    const { session } = await getOrCreateExtraSession(prisma, userId);
    expect(session.id).not.toBe(daily.id);
    expect(session.isExtra).toBe(true);
    expect(session.state).toBe("reading");
  });

  it("加练进行中：重复调用幂等复用同一会话（防连点重复建题）", async () => {
    const userId = await newUser();
    const first = await getOrCreateExtraSession(prisma, userId);
    const second = await getOrCreateExtraSession(prisma, userId);

    expect(second.session.id).toBe(first.session.id);
    expect(await prisma.trainingSession.count({ where: { userId } })).toBe(1);
  });

  it("加练已终答：再调用创建下一道会话（未练题优先，不重练刚完成的题）", async () => {
    const userId = await newUser();
    // a1 已由每日一题练过
    await seedTodaySession(userId, {
      state: "followup",
      finalAnswer: "终答",
      finalSubmittedAt: new Date(),
      startedAt: new Date(Date.now() - 60_000),
    });
    await ensureExtraSeedQuestion();

    const first = await getOrCreateExtraSession(prisma, userId);
    // 已练 a1 被引擎排除 → 确定选中 a2
    expect(first.session.questionId).toBe(EXTRA_SEED_QUESTION_ID);

    // 第一次加练终答后再练：a1/a2 均已练，引擎放宽已练过滤（id 升序取 a1），仍创建新会话
    await prisma.trainingSession.update({
      where: { id: first.session.id },
      data: { state: "followup", finalAnswer: "终答", finalSubmittedAt: new Date() },
    });
    const second = await getOrCreateExtraSession(prisma, userId);
    expect(second.session.id).not.toBe(first.session.id);
    expect(second.session.isExtra).toBe(true);
    expect(second.session.questionId).toBe(SEED_QUESTION_ID);
  });

  it("每日一题进行中：复用该会话，不新建加练（进行中会话至多一个）", async () => {
    const userId = await newUser();
    const daily = await seedTodaySession(userId, { state: "answering" });

    const { session, question } = await getOrCreateExtraSession(prisma, userId);
    expect(session.id).toBe(daily.id);
    expect(session.isExtra).toBe(false);
    expect(question.id).toBe(SEED_QUESTION_ID);
    expect(await prisma.trainingSession.count({ where: { userId } })).toBe(1);
  });
});

describe("getLatestDailySession：当天最近非基线会话（T21）", () => {
  it("多会话：返回 startedAt 最近的一个（进行中的加练自然优先）", async () => {
    const userId = await newUser();
    await seedTodaySession(userId, {
      state: "followup",
      finalAnswer: "终答",
      finalSubmittedAt: new Date(),
      startedAt: new Date(Date.now() - 3_600_000),
    });
    const extra = await seedTodaySession(userId, { isExtra: true });

    const latest = await getLatestDailySession(prisma, userId);
    expect(latest?.session.id).toBe(extra.id);
    expect(latest?.question.id).toBe(SEED_QUESTION_ID);
  });

  it("基线会话（question.kind=baseline）被排除：startedAt 更晚仍返回日常会话", async () => {
    await ensureBaselineKindQuestion();
    const userId = await newUser();
    const daily = await seedTodaySession(userId, {
      state: "followup",
      finalAnswer: "终答",
      finalSubmittedAt: new Date(),
      startedAt: new Date(Date.now() - 3_600_000),
    });
    // 基线会话以 isExtra=true 落库（T17a），不得被当作加练返回
    await seedTodaySession(userId, {
      questionId: BASELINE_KIND_QUESTION_ID,
      isExtra: true,
    });

    const latest = await getLatestDailySession(prisma, userId);
    expect(latest?.session.id).toBe(daily.id);
  });

  it("当天仅基线会话：返回 null", async () => {
    await ensureBaselineKindQuestion();
    const userId = await newUser();
    await seedTodaySession(userId, {
      questionId: BASELINE_KIND_QUESTION_ID,
      isExtra: true,
    });

    expect(await getLatestDailySession(prisma, userId)).toBeNull();
  });

  it("当天无任何会话：返回 null", async () => {
    const userId = await newUser();
    expect(await getLatestDailySession(prisma, userId)).toBeNull();
  });
});
