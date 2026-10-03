import type { PrismaClient, Question } from "@prisma/client";

import {
  RECENT_CASE_WINDOW,
  selectQuestion,
  type SelectionOutcome,
} from "./engine";
import { SELECTION_ERROR_CODES, SelectionError } from "./errors";
import {
  createPrismaSelectionRepository,
  type SelectionRepository,
} from "./repository";

export type { SelectionRepository } from "./repository";

/**
 * 选题服务（US-010 / FR-2 的服务端入口；供 api/training/today 与首页「为什么是它」调用）。
 *
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
}

export interface SelectionDeps {
  /** 可注入 mock 仓储（测试与降级演练）；缺省用 Prisma 实现 */
  repository?: SelectionRepository;
}

/** 降级选题（图 2 失败与回滚）：id 升序取第一道未练的上架题；全部练过则取第一道供重练 */
async function sequentialFallback(db: PrismaClient, userId: string): Promise<SelectionResult> {
  const sessions = await db.trainingSession.findMany({
    where: { userId },
    select: { questionId: true },
  });
  const practicedIds = [...new Set(sessions.map((s) => s.questionId))];
  const question =
    (await db.question.findFirst({
      where: { status: "published", id: { notIn: practicedIds } },
      orderBy: { id: "asc" },
    })) ??
    (await db.question.findFirst({
      where: { status: "published" },
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
    },
  };
}

/** 为用户选出一道今日题（每日一题与加练共用；调用方负责会话落库） */
export async function selectTodayQuestion(
  db: PrismaClient,
  userId: string,
  deps: SelectionDeps = {},
): Promise<SelectionResult> {
  const repository = deps.repository ?? createPrismaSelectionRepository(db);
  try {
    const [profile, preferences, questions, history] = await Promise.all([
      repository.getProfileView(userId),
      repository.getProfilePreferences(userId),
      repository.listPublishedQuestions(),
      repository.listSessionHistory(userId),
    ]);

    const outcome = selectQuestion({
      profile,
      familiarProducts: preferences.familiarProducts,
      interestAreas: preferences.interestAreas,
      questions,
      practicedQuestionIds: new Set(history.map((item) => item.questionId)),
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
    const question = questions.find((q) => q.id === outcome.questionId);
    if (!question) {
      // 引擎返回了候选池之外的 id（数据竞争：选题间隙题目被下架），按异常降级
      throw new Error(`选题结果不在候选池中：${outcome.questionId}`);
    }
    return { question: question as Question, outcome, degraded: false };
  } catch (error) {
    if (error instanceof SelectionError) throw error;
    console.warn(
      JSON.stringify({
        event: "selection.engine_failed_fallback",
        userId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return sequentialFallback(db, userId);
  }
}
