import { describe, expect, it } from "vitest";

import type { PrismaClient, Question, TrainingSession } from "@prisma/client";

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
  it("创建指向 nextQuestion 的会话：isExtra=true（不占每日一题槽位）、状态 reading", async () => {
    const { db, calls } = makeDb({ baselineQuestions: [Q1, Q2], profile: null, sessions: [] });
    const result = await getOrCreateBaselineSession(db, "u-1");
    expect(result.question.id).toBe(Q1.id);
    expect(result.session.id).toBe("session-new");
    expect(calls.sessionCreateData[0]).toMatchObject({
      userId: "u-1",
      questionId: Q1.id,
      isExtra: true, // 每日一题按 isExtra=false 唯一复用，基线会话不得占用该槽位
      state: "reading",
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
