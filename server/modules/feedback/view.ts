import type { PrismaClient } from "@prisma/client";

import { SCORING_ERROR_CODES as CODES, ScoringError } from "@/server/modules/scoring/errors";
import { scoreSession, type ScoreSessionDeps } from "@/server/modules/scoring/service";

import { getSurveyStatus, type SurveyStatus } from "./survey";

/**
 * 训练反馈视图装配（T07 / US-007 / FR-7，Prd.md 2.3 页面 P4）。
 *
 * 懒触发评分：终答已提交但未评分时，后台调用 T06 公开入口 scoreSession
 * （幂等，可安全重复调用），本模块立即返回 scoring 状态供前端轮询——
 * 真实评分延迟 35~49 秒（R5），路由不得同步阻塞等待。
 * 进行中用进程内 inflight 集合去重（与限流器同款的 V1 单实例前提），
 * 重复调用不重复触发 AI；评分失败不落库、标记即释放，下一次轮询自动重试。
 *
 * 已评分会话：经 scoreSession 幂等读取既有结果（不再调 AI），装配反馈视图：
 * 各维度四元组（原始分/提示次数/系数/有效分）+ 最需优化问题 + 下一步方向 + 问卷状态。
 */

type DbClient = PrismaClient;

export interface FeedbackDimensionView {
  dimension: string;
  /** 原始表现分（AI 按 Rubric 评） */
  rawScore: number;
  /** 首次提交前的提示次数 */
  hintCount: number;
  /** 独立完成系数（BR-2） */
  coefficient: number;
  /** 有效得分 = 原始分 × 系数（BR-1） */
  effectiveScore: number;
  diagnosisText: string | null;
}

export interface ReadyFeedbackView {
  status: "ready";
  sessionId: string;
  scores: FeedbackDimensionView[];
  /** 最需要优化的一个问题（BR-7） */
  topIssueText: string;
  /** 下一步训练方向 */
  nextFocusText: string;
  survey: SurveyStatus;
}

export interface ScoringFeedbackView {
  status: "scoring";
  sessionId: string;
}

export type FeedbackView = ReadyFeedbackView | ScoringFeedbackView;

export type FeedbackViewDeps = ScoreSessionDeps;

/** 评分进行中的会话集合（进程内；防并发轮询重复触发 AI 调用） */
const scoringInflight = new Set<string>();

/** 后台触发评分：进行中已存在则跳过；失败仅记录日志，不落库，待轮询重试 */
function triggerBackgroundScoring(
  db: DbClient,
  sessionId: string,
  userId: string,
  deps: FeedbackViewDeps,
): void {
  if (scoringInflight.has(sessionId)) return;
  scoringInflight.add(sessionId);
  void scoreSession(db, sessionId, userId, deps)
    .catch((error: unknown) => {
      // T06 约定：AI 失败不落任何数据，状态停留 followup，可安全重试
      console.error(`[feedback] 会话 ${sessionId} 后台评分失败，等待下一次轮询重试`, error);
    })
    .finally(() => {
      scoringInflight.delete(sessionId);
    });
}

/**
 * 读取反馈视图：未评分 → 懒触发并返回 scoring；已评分 → 返回 ready 装配视图。
 * 错误语义复用评分模块契约（路由层统一映射）：
 * 404 SESSION_NOT_FOUND / 409 SESSION_STATE_INVALID / 409 FINAL_ANSWER_REQUIRED。
 */
export async function getFeedbackView(
  db: DbClient,
  sessionId: string,
  userId: string,
  deps: FeedbackViewDeps = {},
): Promise<FeedbackView> {
  const session = await db.trainingSession.findUnique({
    where: { id: sessionId },
    include: { scores: true },
  });
  if (!session || session.userId !== userId) {
    throw new ScoringError(CODES.SESSION_NOT_FOUND, 404, "训练会话不存在");
  }

  if (session.scores.length === 0) {
    // 守卫条件与 scoreSession 一致：仅终答落库后的 followup 可评分
    if (session.state !== "followup") {
      throw new ScoringError(
        CODES.SESSION_STATE_INVALID,
        409,
        `状态 ${session.state} 下不可评分：作答流程未走完`,
      );
    }
    if (session.finalAnswer === null || session.finalSubmittedAt === null) {
      throw new ScoringError(CODES.FINAL_ANSWER_REQUIRED, 409, "请先提交最终答案");
    }
    triggerBackgroundScoring(db, sessionId, userId, deps);
    return { status: "scoring", sessionId };
  }

  // 已评分：scoreSession 幂等返回既有结果（不重复调 AI、不重复落库）
  const result = await scoreSession(db, sessionId, userId, deps);
  const survey = await getSurveyStatus(db, sessionId, userId);
  return {
    status: "ready",
    sessionId,
    scores: result.scores.map((row) => ({
      dimension: row.dimension,
      rawScore: row.rawScore,
      hintCount: row.hintCount,
      coefficient: row.coefficient,
      effectiveScore: row.effectiveScore,
      diagnosisText: row.diagnosisText,
    })),
    topIssueText: result.feedback.topIssueText,
    nextFocusText: result.feedback.nextFocusText,
    survey,
  };
}
