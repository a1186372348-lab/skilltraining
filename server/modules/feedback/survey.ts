import { Prisma, type PrismaClient } from "@prisma/client";

import { SCORING_ERROR_CODES as CODES, ScoringError } from "@/server/modules/scoring/errors";

/**
 * 感知问卷（T07 / US-007 / FR-7 / D16）。
 *
 * 落库 feedback_surveys：训练后两问（q1 反馈是否说清问题 / q2 下一步是否明确，1~5 分）；
 * 周期性一问（periodic_q3：训练是否越来越"针对自己"）每 5 次已评分训练触发一次，
 * 按该用户 scored 会话计数判定（D16），接口返回是否需要第三问，前端据此渲染。
 *
 * 幂等（T07 失败与回滚约定）：同会话重复提交不覆盖、不重复落库；
 * 问卷提交失败不影响已生成的反馈内容展示，前端可安全重试。
 */

type DbClient = PrismaClient;

/** 周期性一问触发间隔（D16：每 5 次已评分训练一次） */
export const PERIODIC_SURVEY_INTERVAL = 5;

/** 按该用户 scored 会话计数判定是否追加周期性一问；非法输入按不触发处理 */
export function needsPeriodicQuestion(scoredSessionCount: number): boolean {
  if (!Number.isInteger(scoredSessionCount) || scoredSessionCount <= 0) return false;
  return scoredSessionCount % PERIODIC_SURVEY_INTERVAL === 0;
}

export interface SurveyStatus {
  /** 该会话问卷是否已提交（前端据此显示已提交态） */
  submitted: boolean;
  /** 是否追加周期性一问（前端据此渲染第三行星评） */
  needsPeriodicQ3: boolean;
}

export interface SubmitSurveyInput {
  q1Clarity: number;
  q2Next: number;
  /** 仅触发周期内才落库；非触发周期携带会被忽略 */
  periodicQ3?: number;
}

export interface SubmitSurveyResult {
  sessionId: string;
  q1Clarity: number;
  q2Next: number;
  periodicQ3: number | null;
  needsPeriodicQ3: boolean;
  /** false = 幂等命中既有记录（未覆盖） */
  created: boolean;
}

async function countScoredSessions(db: DbClient, userId: string): Promise<number> {
  return db.trainingSession.count({ where: { userId, state: "scored" } });
}

/** 反馈视图装配用：问卷提交状态 + 第三问触发标记 */
export async function getSurveyStatus(
  db: DbClient,
  sessionId: string,
  userId: string,
): Promise<SurveyStatus> {
  const [survey, scoredCount] = await Promise.all([
    db.feedbackSurvey.findUnique({ where: { sessionId } }),
    countScoredSessions(db, userId),
  ]);
  return { submitted: survey !== null, needsPeriodicQ3: needsPeriodicQuestion(scoredCount) };
}

function toResult(
  row: { sessionId: string; q1Clarity: number; q2Next: number; periodicQ3: number | null },
  needsPeriodicQ3: boolean,
  created: boolean,
): SubmitSurveyResult {
  return {
    sessionId: row.sessionId,
    q1Clarity: row.q1Clarity,
    q2Next: row.q2Next,
    periodicQ3: row.periodicQ3,
    needsPeriodicQ3,
    created,
  };
}

/**
 * 提交感知问卷：仅已评分会话可提交（问卷挂在反馈页，评分完成后才出现）。
 * 错误语义复用评分模块契约：404 SESSION_NOT_FOUND（不泄露存在性）/ 409 SESSION_STATE_INVALID。
 */
export async function submitFeedbackSurvey(
  db: DbClient,
  sessionId: string,
  userId: string,
  input: SubmitSurveyInput,
): Promise<SubmitSurveyResult> {
  const session = await db.trainingSession.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) {
    throw new ScoringError(CODES.SESSION_NOT_FOUND, 404, "训练会话不存在");
  }
  if (session.state !== "scored") {
    throw new ScoringError(
      CODES.SESSION_STATE_INVALID,
      409,
      `状态 ${session.state} 下不可提交问卷：评分未完成`,
    );
  }

  const needsPeriodicQ3 = needsPeriodicQuestion(await countScoredSessions(db, userId));

  // 幂等：已有记录直接返回，不覆盖（可安全重试）
  const existing = await db.feedbackSurvey.findUnique({ where: { sessionId } });
  if (existing) return toResult(existing, needsPeriodicQ3, false);

  // 非触发周期忽略携带的第三问，保持数据语义干净
  const periodicQ3 = needsPeriodicQ3 ? (input.periodicQ3 ?? null) : null;
  try {
    const created = await db.feedbackSurvey.create({
      data: { sessionId, q1Clarity: input.q1Clarity, q2Next: input.q2Next, periodicQ3 },
    });
    return toResult(created, needsPeriodicQ3, true);
  } catch (error) {
    // 并发双击：另一方已落库，按幂等返回既有记录
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const fallback = await db.feedbackSurvey.findUnique({ where: { sessionId } });
      if (fallback) return toResult(fallback, needsPeriodicQ3, false);
    }
    throw error;
  }
}
