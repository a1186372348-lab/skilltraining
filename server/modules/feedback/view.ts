import type { PrismaClient } from "@prisma/client";

import { SCORING_ERROR_CODES as CODES, ScoringError } from "@/server/modules/scoring/errors";
import { scoreSession } from "@/server/modules/scoring/service";
import {
  triggerSessionScoring,
  type TriggerSessionScoringDeps,
} from "@/server/modules/scoring/trigger";

import { getSurveyStatus, type SurveyStatus } from "./survey";

/**
 * 训练反馈视图装配（T07 / US-007 / FR-7，Prd.md 2.3 页面 P4）。
 *
 * 懒触发评分：终答已提交但未评分时，经共享入口 triggerSessionScoring 后台调用
 * T06 公开入口 scoreSession（幂等，可安全重复调用；T36 起与终答触发/基线补触发同源），
 * 本模块立即返回 scoring 状态供前端轮询——真实评分延迟 35~49 秒（R5），
 * 路由不得同步阻塞等待。进行中 inflight 去重、失败不落库待重试等语义见 trigger.ts。
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
  /** 题目类型（T36 / D38：基线题反馈页动作按钮与日常题分流——基线不出「再练一题」） */
  questionKind: "baseline" | "daily";
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

// 与 TriggerSessionScoringDeps 对齐：视图 deps 原样透传给懒触发入口（T39 起含 schedule）
export type FeedbackViewDeps = TriggerSessionScoringDeps;

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
    include: { scores: true, question: { select: { kind: true } } },
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
    triggerSessionScoring(db, sessionId, userId, deps);
    return { status: "scoring", sessionId };
  }

  // 已评分：scoreSession 幂等返回既有结果（不重复调 AI、不重复落库）
  const result = await scoreSession(db, sessionId, userId, deps);
  const survey = await getSurveyStatus(db, sessionId, userId);
  return {
    status: "ready",
    sessionId,
    questionKind: session.question.kind,
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
