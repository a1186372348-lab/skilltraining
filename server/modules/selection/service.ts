import type { Question, TrainingPlan } from "@prisma/client";

import {
  weekStartUtc,
} from "@/server/modules/planning";

import {
  RECENT_CASE_WINDOW,
  parseAbilityTags,
  selectQuestion,
  type CandidateQuestion,
  type SelectionOutcome,
} from "./engine";
import { SELECTION_ERROR_CODES, SelectionError } from "./errors";
import {
  createPrismaSelectionRepository,
  type SelectionDb,
  type SelectionRepository,
} from "./repository";

export type { SelectionRepository } from "./repository";

/**
 * 选题服务（US-010 / FR-2 的服务端入口；供 api/training/today 与首页「为什么是它」调用）。
 *
 * - 优先级链（T29 / BR-V2-1）：进行中的训练包 > 本周计划维度 > 待复测维度 > 纯自适应弱项——
 *   本任务接入「计划层」（T29）：本周计划 active 且今日未练计划题时，在主攻维度内选题；
 *   包层（T30）接入点在计划层之前、复测层（T31）接入点在计划层之后（注释级，不提前实现）；
 * - 计划层不懒生成计划（选题是只读动作；计划由 planning 模块首访懒生成，
 *   无计划或 PROFILE_INCOMPLETE 未生成时计划层自然落空，选题完全不受影响）；
 * - 正常路径：仓储取数 → 引擎（纯函数）选题，输出题目 + 可解释理由；
 * - 失败与回滚（T11 任务契约）：选题链路任何异常都降级为「顺序取未练题」，不阻塞训练；
 * - 题库无任何上架题时抛 SelectionError(NO_PUBLISHED_QUESTION)，由路由层映射 404。
 */

export interface SelectionResult {
  /** 选中的题目完整行（供训练会话创建与视图渲染） */
  question: Question;
  /** 选题结果与可解释理由（degraded 时 phase 为 fallback） */
  outcome: SelectionOutcome;
  /** true 表示走了「顺序取未练题」降级路径 */
  degraded: boolean;
  /** 复测层已在持锁事务内开题或恢复，调用方必须复用该会话。 */
  retestSessionId?: string;
}

export interface RetestSelection {
  question: Question;
  sessionId: string;
  triggerId: string;
  dimension: string;
}

class RetestSelectionError extends Error {
  constructor(readonly original: unknown) { super("复测推荐失败"); }
}

export interface SelectionDeps {
  /** 可注入 mock 仓储（测试与降级演练）；缺省用 Prisma 实现 */
  repository?: SelectionRepository;
  /** T29：本周计划读取（缺省经 planning 仓储按本周一读取；测试注入桩） */
  getCurrentPlan?: (userId: string) => Promise<TrainingPlan | null>;
  /** T29：今日是否已练计划题（缺省查库：今日存在 sourceType=plan 会话；测试注入桩） */
  hasPlanSessionToday?: (userId: string) => Promise<boolean>;
  /** 活动包已预留的题；加练及其降级路径不得占用。 */
  excludedQuestionIds?: readonly string[];
  /** 由已持用户锁的训练编排提供；不得为复测额外创建普通会话。 */
  pickRetest?: () => Promise<RetestSelection | null>;
}

/** 今日 0 点（UTC）——与 training/service.ts 的 todayUtc 同口径；本地复制避免 selection→training 环依赖 */
function todayDateUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** 计划层默认计划读取：按本周一查 training_plans（只读，不懒生成——选题是只读动作） */
function defaultGetCurrentPlan(db: SelectionDb): (userId: string) => Promise<TrainingPlan | null> {
  return (userId) => db.trainingPlan.findUnique({ where: { userId_weekStartDate: { userId, weekStartDate: weekStartUtc(todayDateUtc()) } } });
}

/** 计划层默认「今日已练」判定：今日存在 sourceType=plan 会话（每日计划题至多 1 道口径） */
function defaultHasPlanSessionToday(db: SelectionDb): (userId: string) => Promise<boolean> {
  return async (userId) =>
    (await db.trainingSession.count({
      where: { userId, date: todayDateUtc(), sourceType: "plan" },
    })) > 0;
}

/**
 * 计划层（T29 / BR-V2-1）：本周计划 active 且今日未练计划题时，在主攻维度内选题——
 * 候选 = 上架、未练、abilityTags 含主攻维度的第一道（内容侧约定 id 升序）；
 * 无可用候选返回 null（落自适应分支）；命中返回带 sourceType=plan + sourceId + 计划理由的选题结果。
 */
function tryPlanLayer(
  plan: TrainingPlan,
  questions: CandidateQuestion[],
  practicedQuestionIds: ReadonlySet<string>,
): SelectionResult | null {
  const candidate = questions.find(
    (question) =>
      parseAbilityTags(question.abilityTags).includes(plan.focusDimension) &&
      !practicedQuestionIds.has(question.id),
  );
  if (!candidate) return null; // 主攻维度无可用未练题 → 落自适应（不空转不报错）
  return {
    question: candidate as Question,
    degraded: false,
    outcome: {
      questionId: candidate.id,
      phase: "strengthening", // 计划主攻 = 弱项强化的强指定形态（相位沿用强化期语义）
      targetDimensions: [plan.focusDimension],
      reason: `本周计划：${plan.reason}；本题按主攻维度「${plan.focusDimension}」安排（计划层命中）`,
      relaxedFilters: [],
      matchedInterest: null,
      matchedFamiliarProduct: null,
      independenceTraining: false,
      sourceType: "plan",
      sourceId: plan.id,
    },
  };
}

/** 降级选题（图 2 失败与回滚）：id 升序取第一道未练的上架题；全部练过则取第一道供重练。
 *  日常题池只含 kind=daily（T17a / D19：基线题不参与日常出题，降级路径同样排除） */
async function sequentialFallback(db: SelectionDb, userId: string, excludedQuestionIds: readonly string[]): Promise<SelectionResult> {
  const sessions = await db.trainingSession.findMany({
    where: { userId },
    select: { questionId: true },
  });
  const practicedIds = [...new Set([...sessions.map((s) => s.questionId), ...excludedQuestionIds])];
  const question =
    (await db.question.findFirst({
      where: { status: "published", kind: "daily", id: { notIn: practicedIds } },
      orderBy: { id: "asc" },
    })) ??
    (await db.question.findFirst({
      where: { status: "published", kind: "daily", ...(excludedQuestionIds.length ? { id: { notIn: [...excludedQuestionIds] } } : {}) },
      orderBy: { id: "asc" },
    }));
  if (!question) {
    throw new SelectionError(
      SELECTION_ERROR_CODES.NO_PUBLISHED_QUESTION,
      404,
      "题库暂无上架题目",
    );
  }
  return {
    question,
    degraded: true,
    outcome: {
      questionId: question.id,
      phase: "fallback",
      targetDimensions: [],
      reason: "自适应选题暂时不可用，已降级为顺序取未练题，不影响本次训练",
      relaxedFilters: [],
      matchedInterest: null,
      matchedFamiliarProduct: null,
      independenceTraining: false,
      sourceType: "daily",
      sourceId: null,
    },
  };
}

/** 为用户选出一道今日题（每日一题与加练共用；调用方负责会话落库） */
export async function selectTodayQuestion(
  db: SelectionDb,
  userId: string,
  deps: SelectionDeps = {},
): Promise<SelectionResult> {
  const repository = deps.repository ?? createPrismaSelectionRepository(db);
  const excluded = new Set(deps.excludedQuestionIds ?? []);
  try {
    // Defer each invocation so a synchronous dependency failure cannot leave earlier
    // rejected promises without handlers. Report each failure before falling back.
    const checked = <T>(name: string, load: () => Promise<T>): Promise<T> =>
      Promise.resolve().then(load).catch((error: unknown) => {
        console.warn(JSON.stringify({
          event: "selection.dependency_failed",
          dependency: name,
          error: error instanceof Error ? error.message : String(error),
        }));
        throw error;
      });
    const [profile, preferences, questions, history, plan, planPracticedToday] = await Promise.all([
      checked("profile", () => repository.getProfileView(userId)),
      checked("preferences", () => repository.getProfilePreferences(userId)),
      checked("questions", () => repository.listPublishedQuestions()),
      checked("history", () => repository.listSessionHistory(userId)),
      checked("plan", () => (deps.getCurrentPlan ?? defaultGetCurrentPlan(db))(userId)),
      checked("planPracticedToday", () => (deps.hasPlanSessionToday ?? defaultHasPlanSessionToday(db))(userId)),
    ]);
    const practicedQuestionIds = new Set(history.map((item) => item.questionId));
    const availableQuestions = questions.filter(question => !excluded.has(question.id));

    // ── 优先级链前置层（BR-V2-1：包 > 计划 > 复测 > 自适应）──
    // T30 包层接入点：插在计划层之前（本任务不实现）
    if (plan && plan.status === "active" && !planPracticedToday) {
      const planHit = tryPlanLayer(plan, availableQuestions, practicedQuestionIds);
      if (planHit) return planHit;
      // 计划层未命中（主攻维度无可用未练题）→ 落自适应分支
    }
    if (deps.pickRetest) {
      let retest: RetestSelection | null;
      try { retest = await deps.pickRetest(); }
      catch (error) { throw new RetestSelectionError(error); }
      if (retest) return {
        question: retest.question,
        retestSessionId: retest.sessionId,
        degraded: false,
        outcome: {
          questionId: retest.question.id, phase: "strengthening", targetDimensions: [retest.dimension],
          reason: `复测验证：使用未练题检验「${retest.dimension}」`, relaxedFilters: [],
          matchedInterest: null, matchedFamiliarProduct: null, independenceTraining: false,
          sourceType: "retest", sourceId: retest.triggerId,
        },
      };
    }

    const outcome = selectQuestion({
      profile,
      familiarProducts: preferences.familiarProducts,
      interestAreas: preferences.interestAreas,
      questions: availableQuestions,
      practicedQuestionIds,
      recentCaseBackgrounds: history
        .slice(0, RECENT_CASE_WINDOW)
        .map((item) => item.caseBackground),
      isFirstTraining: history.length === 0,
    });
    if (!outcome) {
      // 引擎仅在候选池为空时返回 null：题库无上架题是确定性结果，不走降级重试
      throw new SelectionError(
        SELECTION_ERROR_CODES.NO_PUBLISHED_QUESTION,
        404,
        "题库暂无上架题目",
      );
    }
    const question = availableQuestions.find((q) => q.id === outcome.questionId);
    if (!question) {
      // 引擎返回了候选池之外的 id（数据竞争：选题间隙题目被下架），按异常降级
      throw new Error(`选题结果不在候选池中：${outcome.questionId}`);
    }
    // 自适应路径：sourceType=daily（计划层命中已在上方直接返回 plan）
    return {
      question: question as Question,
      outcome: { ...outcome, sourceType: "daily", sourceId: null },
      degraded: false,
    };
  } catch (error) {
    if (error instanceof RetestSelectionError) throw error.original;
    if (error instanceof SelectionError) throw error;
    console.warn(
      JSON.stringify({
        event: "selection.engine_failed_fallback",
        userId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return sequentialFallback(db, userId, [...excluded]);
  }
}
