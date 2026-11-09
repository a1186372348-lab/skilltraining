import { describe, expect, it } from "vitest";

import type { PrismaClient, Question, TrainingSession } from "@prisma/client";

import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";
import { createPrismaSelectionRepository } from "@/server/modules/selection/repository";
import { selectTodayQuestion } from "@/server/modules/selection/service";

import { BASELINE_ERROR_CODES, BaselineError } from "./errors";
import { getBaselineStatus, getOrCreateBaselineSession } from "./service";

// 基线服务（T17a / D19 / BR-9；T36 / D38 双计数语义）单元测试：桩 DB（不触真实数据库）。
//
// 为什么不用真实库：基线门禁依赖 questions 表的全局状态（kind=baseline 且上架），
// 而测试套件多文件并行共享同一测试库——上架基线题会把其他文件全新用户的
// 今日训练门禁打开，其他文件的归档扫尾又会击落本题，双向竞争必然偶发失败。
// 因此查询过滤（kind/published/scoredAt/finalSubmittedAt）以「捕获 where 入参」方式验证，
// 分支逻辑全部桩定；迁移对空库/现库的正确性由 prisma migrate 冒烟单独验证。
// 路由级门禁分支见 app/api/training/today/route.baseline.test.ts（mock 服务层）。

/** 最小基线题行（toTodayView 不经过这里，仅需 id 等关键字段） */
function makeQuestion(id: string): Question {
  return { id, caseTitle: `基线题 ${id}`, status: "published", kind: "baseline" } as unknown as Question;
}

const Q1 = makeQuestion("00000000-0000-4000-8000-0000000000b1");
const Q2 = makeQuestion("00000000-0000-4000-8000-0000000000b2");

const STAMP = new Date("2026-10-10T00:00:00Z");

/** 基线题会话行（getBaselineStatus 计数查询的 select 形状） */
interface StubSessionRow {
  id: string;
  questionId: string;
  scoredAt: Date | null;
  finalSubmittedAt: Date | null;
}

/** 已评分会话（评分完成必已提交终答） */
function scoredSession(questionId: string, id = `s-scored-${questionId}`): StubSessionRow {
  return { id, questionId, scoredAt: STAMP, finalSubmittedAt: STAMP };
}

/** 已提交终答、评分进行中的会话（T36：作答推进口径） */
function answeredSession(questionId: string, id = `s-answered-${questionId}`): StubSessionRow {
  return { id, questionId, scoredAt: null, finalSubmittedAt: STAMP };
}

interface StubConfig {
  /** question.findMany 返回（基线题池，调用方按 id 升序传入） */
  baselineQuestions: Question[];
  /** userProfile.findUnique 返回（无画像行传 null） */
  profile: { baselineCompletedAt: Date | null } | null;
  /** 用户基线题会话行（一次查询同时取 scoredAt/finalSubmittedAt 双计数） */
  sessions: StubSessionRow[];
  /** userProfile.updateMany 受影响行数（并发另一方已写入时为 0） */
  updateManyCount?: number;
  /** updateMany 未命中后回读的画像（并发另一方写入的标记） */
  profileAfterWrite?: { baselineCompletedAt: Date | null } | null;
  /** trainingSession.findFirst 返回（已存在的基线会话） */
  existingSession?: TrainingSession | null;
}

function makeDb(config: StubConfig) {
  const calls = {
    questionFindManyArgs: [] as unknown[],
    sessionFindManyArgs: [] as unknown[],
    updateManyArgs: [] as unknown[],
    sessionCreateData: [] as Record<string, unknown>[],
    profileFindUniqueCount: 0,
  };
  const db = {
    question: {
      findMany: async (args: unknown) => {
        calls.questionFindManyArgs.push(args);
        return config.baselineQuestions;
      },
    },
    userProfile: {
      findUnique: async () => {
        calls.profileFindUniqueCount += 1;
        // updateMany 未命中后的第二次 findUnique 返回「并发另一方写入」的标记
        return calls.profileFindUniqueCount === 1
          ? config.profile
          : (config.profileAfterWrite ?? config.profile);
      },
      updateMany: async (args: unknown) => {
        calls.updateManyArgs.push(args);
        return { count: config.updateManyCount ?? (config.profile ? 1 : 0) };
      },
    },
    abilityProfile: {
      // T27 切片 3：完成后八维预览事实源；存量用例默认无记录（全部未知态）
      findMany: async () => [],
    },
    trainingSession: {
      findMany: async (args: unknown) => {
        calls.sessionFindManyArgs.push(args);
        return config.sessions;
      },
      findFirst: async () => config.existingSession ?? null,
      findFirstOrThrow: async () => config.existingSession,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.sessionCreateData.push(data);
        return { id: "session-new", ...data };
      },
    },
  } as unknown as PrismaClient;
  return { db, calls };
}

describe("getBaselineStatus：门禁分支（D19 / BR-9）", () => {
  it("库中无上架基线题 → required=false（老用户与新库不受影响）", async () => {
    const { db } = makeDb({ baselineQuestions: [], profile: null, sessions: [] });
    const status = await getBaselineStatus(db, "u-1");
    expect(status).toMatchObject({
      required: false,
      total: 0,
      answeredCount: 0,
      doneCount: 0,
      nextQuestion: null,
    });
  });

  it("基线题池按 kind=baseline + published 过滤、按 id 升序取题", async () => {
    const { db, calls } = makeDb({ baselineQuestions: [Q1, Q2], profile: null, sessions: [] });
    await getBaselineStatus(db, "u-1");
    expect(calls.questionFindManyArgs[0]).toMatchObject({
      where: { kind: "baseline", status: "published" },
      orderBy: { id: "asc" },
    });
    // T36：一次查询同时取已评分/已作答两套计数的事实源（不再只查 scoredAt 非空）
    expect(calls.sessionFindManyArgs[0]).toMatchObject({
      where: { userId: "u-1", questionId: { in: [Q1.id, Q2.id] } },
    });
  });

  it("新用户：required=true，total=2，answeredCount=doneCount=0，nextQuestion 为第一题", async () => {
    const { db } = makeDb({ baselineQuestions: [Q1, Q2], profile: null, sessions: [] });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.required).toBe(true);
    expect(status.total).toBe(2);
    expect(status.answeredCount).toBe(0);
    expect(status.doneCount).toBe(0);
    expect(status.nextQuestion?.id).toBe(Q1.id);
    expect(status.pendingScoringSessionIds).toEqual([]);
  });

  it("第 1 题已评分：answeredCount=doneCount=1，nextQuestion 为第 2 题，仍需基线", async () => {
    const { db } = makeDb({
      baselineQuestions: [Q1, Q2],
      profile: null,
      sessions: [scoredSession(Q1.id)],
    });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.required).toBe(true);
    expect(status.answeredCount).toBe(1);
    expect(status.doneCount).toBe(1);
    expect(status.nextQuestion?.id).toBe(Q2.id);
  });

  it("第 1 题仅作答未评分（T36）：answeredCount=1、doneCount=0，nextQuestion 仍推进到第 2 题", async () => {
    const { db, calls } = makeDb({
      baselineQuestions: [Q1, Q2],
      profile: null,
      sessions: [answeredSession(Q1.id)],
    });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.required).toBe(true);
    expect(status.answeredCount).toBe(1);
    expect(status.doneCount).toBe(0);
    expect(status.nextQuestion?.id).toBe(Q2.id);
    // 待评分会话带出（路由层补触发自愈用）
    expect(status.pendingScoringSessionIds).toEqual([`s-answered-${Q1.id}`]);
    // 未全部评完：不得写入完成标记
    expect(calls.updateManyArgs).toHaveLength(0);
  });

  it("同一题多条会话只按题去重计数（中断重建的防御）", async () => {
    const { db } = makeDb({
      baselineQuestions: [Q1, Q2],
      profile: null,
      sessions: [
        answeredSession(Q1.id, "s-1"),
        scoredSession(Q1.id, "s-2"),
        answeredSession(Q1.id, "s-3"),
      ],
    });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.answeredCount).toBe(1);
    expect(status.doneCount).toBe(1);
    // 已评分题下的未评分会话仍属待评分（重复会话各自补触发，评分幂等兜底）
    expect(status.pendingScoringSessionIds).toEqual(["s-1", "s-3"]);
  });

  it("只评了第 2 题（跳题异常）：nextQuestion 仍按固定顺序指向第 1 题", async () => {
    const { db } = makeDb({
      baselineQuestions: [Q1, Q2],
      profile: null,
      sessions: [scoredSession(Q2.id)],
    });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.required).toBe(true);
    expect(status.doneCount).toBe(1);
    expect(status.nextQuestion?.id).toBe(Q1.id);
  });

  it("边界：全部已作答未全部评完 → required=true 且 nextQuestion=null，不写完成标记", async () => {
    const { db, calls } = makeDb({
      baselineQuestions: [Q1, Q2],
      profile: null,
      sessions: [scoredSession(Q1.id), answeredSession(Q2.id)],
    });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.required).toBe(true);
    expect(status.answeredCount).toBe(2);
    expect(status.doneCount).toBe(1);
    expect(status.nextQuestion).toBeNull();
    expect(status.pendingScoringSessionIds).toEqual([`s-answered-${Q2.id}`]);
    expect(status.completedAt).toBeNull();
    // 完成判定只认 doneCount：中途不得写入 baseline_completed_at
    expect(calls.updateManyArgs).toHaveLength(0);
  });

  it("全部评完且无标记 → 幂等写入 baseline_completed_at（守卫条件 updateMany）", async () => {
    const { db, calls } = makeDb({
      baselineQuestions: [Q1, Q2],
      profile: { baselineCompletedAt: null },
      sessions: [scoredSession(Q1.id), scoredSession(Q2.id)],
    });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.required).toBe(false);
    expect(status.answeredCount).toBe(2);
    expect(status.doneCount).toBe(2);
    expect(status.nextQuestion).toBeNull();
    expect(status.completedAt).not.toBeNull();
    expect(calls.updateManyArgs[0]).toMatchObject({
      where: { userId: "u-1", baselineCompletedAt: null },
    });
  });

  it("全部评完且标记已存在 → 不重复写入（幂等，时间戳不被覆盖）", async () => {
    const marker = new Date("2026-10-04T00:00:00Z");
    const { db, calls } = makeDb({
      baselineQuestions: [Q1, Q2],
      profile: { baselineCompletedAt: marker },
      sessions: [scoredSession(Q1.id), scoredSession(Q2.id)],
    });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.required).toBe(false);
    expect(status.completedAt?.getTime()).toBe(marker.getTime());
    expect(calls.updateManyArgs).toHaveLength(0);
  });

  it("并发写入冲突（updateMany 未命中）→ 回读以另一方标记为准", async () => {
    const concurrent = new Date("2026-10-04T01:00:00Z");
    const { db } = makeDb({
      baselineQuestions: [Q1, Q2],
      profile: { baselineCompletedAt: null },
      profileAfterWrite: { baselineCompletedAt: concurrent },
      sessions: [scoredSession(Q1.id), scoredSession(Q2.id)],
      updateManyCount: 0,
    });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.required).toBe(false);
    expect(status.completedAt?.getTime()).toBe(concurrent.getTime());
  });

  it("无画像行的用户全部评完：required=false 且不报错（标记无处写入不影响判定）", async () => {
    const { db } = makeDb({
      baselineQuestions: [Q1, Q2],
      profile: null,
      sessions: [scoredSession(Q1.id), scoredSession(Q2.id)],
      updateManyCount: 0,
    });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.required).toBe(false);
    expect(status.completedAt).toBeNull();
  });

  it("标记已存在但会话数据缺失（数据漂移）→ 以标记为准，不再要求基线", async () => {
    const marker = new Date("2026-10-04T00:00:00Z");
    const { db } = makeDb({
      baselineQuestions: [Q1, Q2],
      profile: { baselineCompletedAt: marker },
      sessions: [],
    });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.required).toBe(false);
    expect(status.nextQuestion).toBeNull();
  });
});

describe("getOrCreateBaselineSession：会话复用训练闭环", () => {
  it("创建指向 nextQuestion 的会话：isExtra=true（不占每日一题槽位）、状态 reading、sourceType=baseline（T29 透传）", async () => {
    const { db, calls } = makeDb({ baselineQuestions: [Q1, Q2], profile: null, sessions: [] });
    const result = await getOrCreateBaselineSession(db, "u-1");
    expect(result.question.id).toBe(Q1.id);
    expect(result.session.id).toBe("session-new");
    expect(calls.sessionCreateData[0]).toMatchObject({
      userId: "u-1",
      questionId: Q1.id,
      isExtra: true, // 每日一题按 isExtra=false 唯一复用，基线会话不得占用该槽位
      state: "reading",
      sourceType: "baseline", // T29：基线题会话透传落库（P3 公共前置）
    });
    expect(calls.sessionCreateData[0]?.date).toBeInstanceOf(Date);
  });

  it("已存在该题会话 → 直接复用，不重复创建（中断恢复）", async () => {
    const existing = { id: "session-existing", question: Q1 } as unknown as TrainingSession;
    const { db, calls } = makeDb({
      baselineQuestions: [Q1, Q2],
      profile: null,
      sessions: [],
      existingSession: existing,
    });
    const result = await getOrCreateBaselineSession(db, "u-1");
    expect(result.session.id).toBe("session-existing");
    expect(calls.sessionCreateData).toHaveLength(0);
  });

  it("第 1 题仅作答未评分（T36）：新会话也自动指向第 2 题（按作答推进，不等评分）", async () => {
    const { db, calls } = makeDb({
      baselineQuestions: [Q1, Q2],
      profile: null,
      sessions: [answeredSession(Q1.id)],
    });
    const result = await getOrCreateBaselineSession(db, "u-1");
    expect(result.question.id).toBe(Q2.id);
    expect(calls.sessionCreateData[0]).toMatchObject({ questionId: Q2.id });
  });

  it("全部已作答待评分（nextQuestion=null）→ 抛 BASELINE_NOT_REQUIRED，由 today 路由挡回", async () => {
    const { db } = makeDb({
      baselineQuestions: [Q1, Q2],
      profile: null,
      sessions: [scoredSession(Q1.id), answeredSession(Q2.id)],
    });
    await expect(getOrCreateBaselineSession(db, "u-1")).rejects.toMatchObject({
      name: "BaselineError",
      code: BASELINE_ERROR_CODES.BASELINE_NOT_REQUIRED,
    } satisfies Partial<BaselineError>);
  });

  it("无基线题或基线已完成 → 抛 BaselineError(BASELINE_NOT_REQUIRED)", async () => {
    const { db } = makeDb({ baselineQuestions: [], profile: null, sessions: [] });
    await expect(getOrCreateBaselineSession(db, "u-1")).rejects.toMatchObject({
      name: "BaselineError",
      code: BASELINE_ERROR_CODES.BASELINE_NOT_REQUIRED,
    } satisfies Partial<BaselineError>);
  });
});

describe("选题引擎日常题池排除 kind=baseline（T17a / BR-9）", () => {
  it("正常路径仓储 listPublishedQuestions 按 kind=daily 过滤", async () => {
    const findManyArgs: unknown[] = [];
    const db = {
      question: {
        findMany: async (args: unknown) => {
          findManyArgs.push(args);
          return [];
        },
      },
    } as unknown as PrismaClient;
    await createPrismaSelectionRepository(db).listPublishedQuestions();
    expect(findManyArgs[0]).toMatchObject({
      where: { status: "published", kind: "daily" },
      orderBy: { id: "asc" },
    });
  });

  it("正常路径仓储与降级路径的取题查询都按 kind=daily 过滤", async () => {
    const questionFindFirstArgs: unknown[] = [];
    const db = {
      trainingSession: { findMany: async () => [] },
      question: {
        findFirst: async (args: unknown) => {
          questionFindFirstArgs.push(args);
          return makeQuestion("daily-seed");
        },
      },
    } as unknown as PrismaClient;

    // 仓储抛错 → 走「顺序取未练题」降级路径
    const result = await selectTodayQuestion(db, "u-1", {
      repository: {
        getProfileView: async () => {
          throw new Error("profile store down");
        },
        getProfilePreferences: async () => ({ familiarProducts: [], interestAreas: [] }),
        listPublishedQuestions: async () => [],
        listSessionHistory: async () => [],
      },
    });

    expect(result.degraded).toBe(true);
    expect(questionFindFirstArgs.length).toBeGreaterThan(0);
    for (const args of questionFindFirstArgs) {
      expect(args).toMatchObject({ where: { status: "published", kind: "daily" } });
    }
  });
});

/* ============================== T27 切片 2：八维题序与加深（D30 / BR-V2-6） ============================== */

/** 带主测维度标签的基线题（八维归位与加深判定的前提；abilityTags 首位即主测维度） */
function makeTaggedQuestion(id: string, firstTag: string): Question {
  return {
    id,
    caseTitle: `基线题 ${id}`,
    status: "published",
    kind: "baseline",
    abilityTags: [firstTag, "辅测维度"],
  } as unknown as Question;
}

/** 八维各 2 道候选的完整题库（id 形如 d<维序号>-<a 主题/b 加深>） */
function taggedPool(): Question[] {
  return ABILITY_DIMENSIONS.flatMap((dimension, index) => [
    makeTaggedQuestion(`d${index}-a`, dimension),
    makeTaggedQuestion(`d${index}-b`, dimension),
  ]);
}

/** 已评分会话的置信度行（repository listBaselineConfidences 的返回形状） */
function confOf(questionId: string, confidence: number | null) {
  return { confidence, session: { questionId } };
}

/** 带置信度桩的配置（StubConfig 超集；新增字段不影响存量用例） */
function makeTaggedDb(
  config: StubConfig & { confidenceRows?: unknown[]; abilityScores?: { dimension: string; currentScore: number | null }[] },
) {
  const { db, calls } = makeDb(config);
  const extra = db as unknown as {
    score: { findMany: (args: unknown) => Promise<unknown> };
    abilityProfile: { findMany: (args: unknown) => Promise<unknown> };
  };
  extra.score = { findMany: async () => config.confidenceRows ?? [] };
  extra.abilityProfile = { findMany: async () => config.abilityScores ?? [] };
  return { db, calls };
}

const P = (index: number, candidate: "a" | "b" = "a") => `d${index}-${candidate}`;

describe("getBaselineStatus：八维固定题序（T27 / D30；V1 id 升序语义迁移）", () => {
  it("新用户：题序按 ABILITY_DIMENSIONS 八维顺序（乱序题库归位），total=8（8 主题，非上架 16 道）", async () => {
    const { db } = makeTaggedDb({
      baselineQuestions: [...taggedPool()].reverse(),
      profile: null,
      sessions: [],
    });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.total).toBe(8); // total 语义迁移：8 + 已触发加深数（原为实际上架数）
    expect(status.required).toBe(true);
    expect(status.nextQuestion?.id).toBe(P(0)); // 问题定义主题（八维首位，而非 id 最小题）
  });

  it("第 1 题仅作答未评分：nextQuestion 推进到第 2 维主题；未评分不触发加深（时序：首题评分完成后）", async () => {
    const { db } = makeTaggedDb({
      baselineQuestions: taggedPool(),
      profile: null,
      sessions: [answeredSession(P(0))],
      confidenceRows: [], // 尚无评分落库
    });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.total).toBe(8); // 评分未落库 → 尚无加深
    expect(status.nextQuestion?.id).toBe(P(1));
  });

  it("存量无八维标注的基线题（V1 综合题形态）→ 回退 id 升序语义（兼容桥，total=上架数）", async () => {
    const { db } = makeDb({ baselineQuestions: [Q1, Q2], profile: null, sessions: [] });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.total).toBe(2);
    expect(status.nextQuestion?.id).toBe(Q1.id);
  });
});

describe("getBaselineStatus：confidence 加深触发与序列（BR-V2-6）", () => {
  it("首题评分 confidence < 70 → 该维加深题插入同维主题之后；下一题为加深题（首题评分完成后出现）", async () => {
    const { db } = makeTaggedDb({
      baselineQuestions: taggedPool(),
      profile: null,
      sessions: [scoredSession(P(0))],
      confidenceRows: [confOf(P(0), 60)],
    });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.total).toBe(9); // 8 + 1 维加深
    expect(status.nextQuestion?.id).toBe(P(0, "b")); // 加深题紧随同维主题
  });

  it("confidence 边界：= 70 不触发、NULL 不触发、69 触发", async () => {
    const at70 = await getBaselineStatus(
      makeTaggedDb({ baselineQuestions: taggedPool(), profile: null, sessions: [scoredSession(P(0))], confidenceRows: [confOf(P(0), 70)] }).db,
      "u-1",
    );
    expect(at70.total).toBe(8);
    const nullConf = await getBaselineStatus(
      makeTaggedDb({ baselineQuestions: taggedPool(), profile: null, sessions: [scoredSession(P(0))], confidenceRows: [confOf(P(0), null)] }).db,
      "u-1",
    );
    expect(nullConf.total).toBe(8);
    const at69 = await getBaselineStatus(
      makeTaggedDb({ baselineQuestions: taggedPool(), profile: null, sessions: [scoredSession(P(0))], confidenceRows: [confOf(P(0), 69)] }).db,
      "u-1",
    );
    expect(at69.total).toBe(9);
  });

  it("每维至多 1 次；>4 维低置信度按八维顺序至多 4 维加深（total=12 封顶）", async () => {
    const allScored = ABILITY_DIMENSIONS.map((_, i) => scoredSession(P(i)));
    const allLow = ABILITY_DIMENSIONS.map((_, i) => confOf(P(i), 0));
    const { db } = makeTaggedDb({ baselineQuestions: taggedPool(), profile: null, sessions: allScored, confidenceRows: allLow });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.total).toBe(12); // 8 + 4 维加深封顶（D30）
    expect(status.required).toBe(true); // 加深题未作答，未完成
    expect(status.nextQuestion?.id).toBe(P(0, "b")); // 第 1 道待答 = 八维首维加深题
  });

  it("阈值注入：deps.deepenThreshold=50 时 60 分不触发", async () => {
    const { db } = makeTaggedDb({
      baselineQuestions: taggedPool(),
      profile: null,
      sessions: [scoredSession(P(0))],
      confidenceRows: [confOf(P(0), 60)],
    });
    const status = await getBaselineStatus(db, "u-1", { deepenThreshold: 50 });
    expect(status.total).toBe(8);
  });
});

describe("getBaselineStatus：含加深题的完成判定与断点续测（T27 切片 2）", () => {
  it("8 主题全部评分（无加深）→ 守卫写入完成标记；重复调用不重复写（边界：8 题无加深）", async () => {
    const allScored = ABILITY_DIMENSIONS.map((_, i) => scoredSession(P(i)));
    const allHigh = ABILITY_DIMENSIONS.map((_, i) => confOf(P(i), 95));
    const marker = new Date("2026-10-22T09:00:00Z");
    const { db, calls } = makeTaggedDb({ baselineQuestions: taggedPool(), profile: { baselineCompletedAt: null }, profileAfterWrite: { baselineCompletedAt: marker }, sessions: allScored, confidenceRows: allHigh });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.total).toBe(8);
    expect(status.required).toBe(false);
    expect(status.completedAt).not.toBeNull();
    expect(calls.updateManyArgs).toHaveLength(1);
    // 重复调用：标记已存在 → 不再写
    const again = await getBaselineStatus(db, "u-1");
    expect(again.required).toBe(false);
    expect(again.completedAt?.getTime()).toBe(marker.getTime()); // 回读首次写入的标记（幂等）
    expect(calls.updateManyArgs).toHaveLength(1);
  });

  it("含加深题未完成：加深题已作答未评分不写标记；加深题评完才守卫写入", async () => {
    const primariesScored = ABILITY_DIMENSIONS.map((_, i) => scoredSession(P(i)));
    const { db, calls } = makeTaggedDb({
      baselineQuestions: taggedPool(),
      profile: { baselineCompletedAt: null },
      sessions: [...primariesScored, answeredSession(P(0, "b"))],
      confidenceRows: [confOf(P(0), 60), ...ABILITY_DIMENSIONS.slice(1).map((_, i) => confOf(P(i + 1), 95))],
    });
    const pending = await getBaselineStatus(db, "u-1");
    expect(pending.total).toBe(9);
    expect(pending.required).toBe(true); // 加深题未评分 → 未完成
    expect(calls.updateManyArgs).toHaveLength(0);

    // 加深题评分落库 → 全部评完才写
    const { db: db2, calls: calls2 } = makeTaggedDb({
      baselineQuestions: taggedPool(),
      profile: { baselineCompletedAt: null },
      sessions: [...primariesScored, scoredSession(P(0, "b"))],
      confidenceRows: [confOf(P(0), 60), ...ABILITY_DIMENSIONS.slice(1).map((_, i) => confOf(P(i + 1), 95))],
    });
    const done = await getBaselineStatus(db2, "u-1");
    expect(done.required).toBe(false);
    expect(done.completedAt).not.toBeNull();
    expect(calls2.updateManyArgs).toHaveLength(1);
  });

  it("断点续测：已答前 3 维且首维触发加深 → getOrCreate 回到首维加深题；已评分题不重复作答；复用既有会话幂等", async () => {
    const sessions = [scoredSession(P(0)), scoredSession(P(1)), scoredSession(P(2))];
    const confidenceRows = [confOf(P(0), 60), confOf(P(1), 95), confOf(P(2), 95)];
    const { db, calls } = makeTaggedDb({ baselineQuestions: taggedPool(), profile: null, sessions, confidenceRows });
    const result = await getOrCreateBaselineSession(db, "u-1");
    expect(result.question.id).toBe(P(0, "b")); // 当前应继续的题 = 首维加深题（非第 4 维）
    expect(calls.sessionCreateData[0]).toMatchObject({ questionId: P(0, "b"), isExtra: true });

    // 该题已存在会话 → 幂等复用不新建（断点恢复）
    const existing = { id: "session-deepen", question: { id: P(0, "b") } } as unknown as TrainingSession;
    const { db: db2, calls: calls2 } = makeTaggedDb({
      baselineQuestions: taggedPool(),
      profile: null,
      sessions,
      confidenceRows,
      existingSession: existing,
    });
    const reused = await getOrCreateBaselineSession(db2, "u-1");
    expect(reused.session.id).toBe("session-deepen");
    expect(calls2.sessionCreateData).toHaveLength(0);
  });

  it("题库无基线题兜底保留：required=false（与本切片题序逻辑无关的既有语义）", async () => {
    const { db } = makeTaggedDb({ baselineQuestions: [], profile: null, sessions: [] });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.required).toBe(false);
    expect(status.total).toBe(0);
  });
});

describe("getBaselineStatus：逐题进度 items 与 scoringPending（T27 切片 3）", () => {
  it("新用户：items 按序列下发（orderIndex 位次、dimension、isDeepen=false），首题为 active 其余 pending", async () => {
    const { db } = makeTaggedDb({ baselineQuestions: taggedPool(), profile: null, sessions: [] });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.items).toHaveLength(8);
    expect(status.items[0]).toEqual({
      questionId: P(0),
      dimension: "问题定义",
      orderIndex: 0,
      state: "active", // 当前应继续的题
      isDeepen: false,
    });
    expect(status.items[1]).toMatchObject({ questionId: P(1), dimension: "用户理解", orderIndex: 1, state: "pending" });
    expect(status.items.map((i) => i.dimension)).toEqual([...ABILITY_DIMENSIONS]);
    expect(status.scoringPending).toBe(false);
  });

  it("state 迁移：已作答未评分 → active（评分/判定中）；已评分 → scored；触发后加深题入列 isDeepen=true，未触发不入列", async () => {
    const { db } = makeTaggedDb({
      baselineQuestions: taggedPool(),
      profile: null,
      sessions: [scoredSession(P(0)), answeredSession(P(1))],
      confidenceRows: [confOf(P(0), 60)],
    });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.items.map((i) => i.questionId)).toEqual([P(0), P(0, "b"), ...ABILITY_DIMENSIONS.slice(1).map((_, i) => P(i + 1))]);
    const byId = new Map(status.items.map((i) => [i.questionId, i]));
    expect(byId.get(P(0))).toMatchObject({ state: "scored", isDeepen: false });
    expect(byId.get(P(0, "b"))).toMatchObject({ state: "active", isDeepen: true, orderIndex: 1 }); // 加深题紧随同维主题
    expect(byId.get(P(1))).toMatchObject({ state: "active", isDeepen: false }); // 已作答未评分
    expect(byId.get(P(2))).toMatchObject({ state: "pending" });
    expect(status.scoringPending).toBe(true); // 有序列内已作答未评分会话
    // 未触发的加深候选绝不出现在 items
    expect(status.items.some((i) => i.isDeepen && i.questionId === P(1, "b"))).toBe(false);
  });

  it("scoringPending 语义：全部已作答且有未评分 → true；全部评完或全部未答 → false", async () => {
    const allAnswered = ABILITY_DIMENSIONS.map((_, i) => answeredSession(P(i)));
    const { db } = makeTaggedDb({ baselineQuestions: taggedPool(), profile: null, sessions: allAnswered });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.scoringPending).toBe(true);
    const allScored = ABILITY_DIMENSIONS.map((_, i) => scoredSession(P(i)));
    const { db: db2 } = makeTaggedDb({ baselineQuestions: taggedPool(), profile: null, sessions: allScored, confidenceRows: ABILITY_DIMENSIONS.map((_, i) => confOf(P(i), 95)) });
    expect((await getBaselineStatus(db2, "u-1")).scoringPending).toBe(false);
  });

  it("兼容桥（存量无标注题）：items 照出、dimension 为 null、state 迁移一致", async () => {
    const { db } = makeDb({
      baselineQuestions: [Q1, Q2],
      profile: null,
      sessions: [answeredSession(Q1.id)],
    });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.items).toHaveLength(2);
    expect(status.items[0]).toMatchObject({ questionId: Q1.id, dimension: null, state: "active", isDeepen: false });
    expect(status.items[1]).toMatchObject({ questionId: Q2.id, dimension: null, state: "active" }); // 当前待作答第一题
  });
});

describe("getBaselineStatus：完成后八维点亮预览 dimensionPreview（BR-6 未知态口径）", () => {
  it("未完成：dimensionPreview 为 null；完成：八维齐全、有分给付分、无分为 null（维度分=历史有效分简单平均，未知不落 0）", async () => {
    const inProgress = await getBaselineStatus(
      makeTaggedDb({ baselineQuestions: taggedPool(), profile: null, sessions: [] }).db,
      "u-1",
    );
    expect(inProgress.dimensionPreview).toBeNull();

    const allScored = ABILITY_DIMENSIONS.map((_, i) => scoredSession(P(i)));
    const { db } = makeTaggedDb({
      baselineQuestions: taggedPool(),
      profile: { baselineCompletedAt: null },
      sessions: allScored,
      confidenceRows: ABILITY_DIMENSIONS.map((_, i) => confOf(P(i), 95)),
      abilityScores: [
        { dimension: "问题定义", currentScore: 72.5 },
        { dimension: "用户理解", currentScore: 60 },
      ],
    });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.required).toBe(false);
    expect(status.dimensionPreview).toHaveLength(8);
    expect(status.dimensionPreview?.[0]).toEqual({ dimension: "问题定义", effectiveScore: 72.5 });
    expect(status.dimensionPreview?.[1]).toEqual({ dimension: "用户理解", effectiveScore: 60 });
    // 未知维度：effectiveScore 为 null（BR-6 未知态，不落 0 分）
    expect(status.dimensionPreview?.[2]).toEqual({ dimension: "根因分析", effectiveScore: null });
    expect(status.dimensionPreview?.map((i) => i.dimension)).toEqual([...ABILITY_DIMENSIONS]);
  });
});

describe("基线补测锁定与缺维", () => {
  it("部分维度缺题时即使现有题均评分也不能完成", async () => {
    const { db, calls } = makeTaggedDb({ baselineQuestions: taggedPool().slice(0, 2), profile: { baselineCompletedAt: null }, sessions: [scoredSession(P(0))], confidenceRows: [confOf(P(0), 90)] });
    const status = await getBaselineStatus(db, "u-1");
    expect(status.required).toBe(true);
    expect(calls.updateManyArgs).toHaveLength(0);
  });
  it("晚到低置信度不会挤掉已经作答的补测题", async () => {
    const sessions = [...ABILITY_DIMENSIONS.map((_, i) => scoredSession(P(i))), ...[4, 5, 6, 7].map((i) => answeredSession(P(i, "b")))];
    const confidenceRows = ABILITY_DIMENSIONS.map((_, i) => confOf(P(i), 20));
    const status = await getBaselineStatus(makeTaggedDb({ baselineQuestions: taggedPool(), profile: null, sessions, confidenceRows }).db, "u-1");
    expect(status.total).toBe(12);
    expect(status.items.filter((item) => item.isDeepen).map((item) => item.questionId)).toEqual([4, 5, 6, 7].map((i) => P(i, "b")));
  });
});
  it("已创建但尚未作答的补测也保留", async () => {
    const sessions = [4, 5, 6, 7].map((i) => ({ id: `reserved-${i}`, questionId: P(i, "b"), scoredAt: null, finalSubmittedAt: null }));
    const confidenceRows = ABILITY_DIMENSIONS.map((_, i) => confOf(P(i), 20));
    const status = await getBaselineStatus(makeTaggedDb({ baselineQuestions: taggedPool(), profile: null, sessions, confidenceRows }).db, "u-1");
    expect(status.items.filter((item) => item.isDeepen).map((item) => item.questionId)).toEqual([4, 5, 6, 7].map((i) => P(i, "b")));
  });

it("序列化冲突后重新读取状态并重算题目", async () => {
  const { db, calls } = makeTaggedDb({ baselineQuestions: taggedPool(), profile: null, sessions: [], confidenceRows: [] });
  let attempts = 0;
  const transactionDb = Object.assign(db, {
    $transaction: async (work: (tx: PrismaClient) => Promise<unknown>) => {
      attempts += 1;
      const result = await work(db);
      if (attempts === 1) throw Object.assign(new Error("retry"), { code: "P2034" });
      return result;
    },
  });
  const status = await getBaselineStatus(transactionDb, "u-1");
  expect(status.nextQuestion?.id).toBe(P(0));
  expect(attempts).toBe(2);
  expect(calls.questionFindManyArgs).toHaveLength(2);
  expect(calls.sessionFindManyArgs).toHaveLength(2);
});

it("显示补测之前在事务中预建基线会话", async () => {
  const { db, calls } = makeTaggedDb({ baselineQuestions: taggedPool(), profile: null, sessions: [scoredSession(P(0))], confidenceRows: [confOf(P(0), 30)] });
  Object.assign(db, { $transaction: async (work: (tx: PrismaClient) => Promise<unknown>) => work(db) });
  const status = await getBaselineStatus(db, "u-1");
  expect(status.items.some((item) => item.questionId === P(0, "b"))).toBe(true);
  expect(calls.sessionCreateData).toHaveLength(1);
  expect(calls.sessionCreateData[0]).toMatchObject({ userId: "u-1", questionId: P(0, "b"), isExtra: true, sourceType: "baseline", state: "reading" });
});

it.each([
  ["B3", "B4", "问题定义"], ["B5", "B6", "用户理解"], ["B17", "B18", "产品表达"],
])("恢复备用题后旧主题 %s 保持主题并使用其置信度", async (oldId, restoredId, dimension) => {
  const { questionUuid } = await import("@/server/modules/content/question-id");
  const original = questionUuid(oldId);
  const restored = questionUuid(restoredId);
  const pool = [makeTaggedQuestion(original, dimension), makeTaggedQuestion(restored, dimension)];
  const high = await getBaselineStatus(makeTaggedDb({ baselineQuestions: pool, profile: null, sessions: [scoredSession(original)], confidenceRows: [confOf(original, 90)] }).db, "u-1");
  expect(high.items.map((item) => [item.questionId, item.isDeepen])).toEqual([[original, false]]);
  const low = await getBaselineStatus(makeTaggedDb({ baselineQuestions: pool, profile: null, sessions: [scoredSession(original)], confidenceRows: [confOf(original, 30)] }).db, "u-1");
  expect(low.items.map((item) => [item.questionId, item.isDeepen])).toEqual([[original, false], [restored, true]]);
});

it("预建无操作补测不应反向成为主题", async () => {
  const pool = taggedPool();
  const status = await getBaselineStatus(makeTaggedDb({ baselineQuestions: pool, profile: null, sessions: [scoredSession(P(0)), { id: "reserved", questionId: P(0, "b"), scoredAt: null, finalSubmittedAt: null }], confidenceRows: [confOf(P(0), 20)] }).db, "u-1");
  expect(status.items.slice(0, 2).map((item) => [item.questionId, item.isDeepen])).toEqual([[P(0), false], [P(0, "b"), true]]);
});

it("恢复备用题时已激活旧主题继续作为主题并恢复作答", async () => {
  const { questionUuid } = await import("@/server/modules/content/question-id");
  const original = questionUuid("B3");
  const restored = questionUuid("B4");
  const active = { id: "old", questionId: original, scoredAt: null, finalSubmittedAt: null, baselineActivatedAt: STAMP, state: "reading" };
  const status = await getBaselineStatus(makeTaggedDb({ baselineQuestions: [makeTaggedQuestion(restored, "问题定义"), makeTaggedQuestion(original, "问题定义")], profile: null, sessions: [active] }).db, "u-1");
  expect(status.nextQuestion?.id).toBe(original);
  expect(status.items.map((item) => [item.questionId, item.isDeepen])).toEqual([[original, false]]);
});

it("旧主题先评分、补测后预建及激活时仍保持旧主题", async () => {
  const { questionUuid } = await import("@/server/modules/content/question-id");
  const original = questionUuid("B3");
  const restored = questionUuid("B4");
  const activeDeepen = { id: "deep", questionId: restored, scoredAt: null, finalSubmittedAt: null, baselineActivatedAt: STAMP, state: "reading" };
  const status = await getBaselineStatus(makeTaggedDb({ baselineQuestions: [makeTaggedQuestion(restored, "问题定义"), makeTaggedQuestion(original, "问题定义")], profile: null, sessions: [scoredSession(original), activeDeepen], confidenceRows: [confOf(original, 30)] }).db, "u-1");
  expect(status.nextQuestion?.id).toBe(restored);
  expect(status.items.map((item) => [item.questionId, item.isDeepen])).toEqual([[original, false], [restored, true]]);
});
