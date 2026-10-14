import type { PrismaClient, Question } from "@prisma/client";

import { refreshAbilityProfile } from "@/server/modules/profile/ability";
import { independenceCoefficient } from "@/server/modules/training/coefficient";
import { nextState } from "@/server/modules/training/state-machine";
import { parseFollowupRecords } from "@/server/modules/training/today-view";

import { SCORING_ERROR_CODES as CODES, ScoringError } from "./errors.ts";
import {
  scoreWithRubric,
  type RubricScoringInput,
  type RubricScoringOutput,
} from "./rubric-scorer.ts";

/**
 * 评分服务（Prd.md 图 1 的 SCO 模块 / 图 3；US-006、FR-5/FR-6）。
 *
 * 链路：终答提交后 → 按该题能力标签覆盖维度的 Rubric 调 AI 评分（BR-1）
 * → 有效分 = 原始分 × max(0.6, 1 − 0.1×提示次数)（BR-1/BR-2，复用 training 系数实现）
 * → 四元组（raw_score/hint_count/coefficient/effective_score）按维度落库 scores（D8 原始值分开存）
 * → 写 session_feedback（top_issue/next_focus，BR-7）
 * → 状态经 MARK_SCORED 推进 scored（T05 预留接入点）
 * → 同事务更新能力画像（BR-6/FR-6）。
 *
 * 幂等（US-006/3.5）：已有有效 scores 直接返回既有结果，不重复调 AI、不重复落库；
 * 状态推进用带守卫条件的 updateMany（原子），并发重复触发只有一方落库，
 * 另一方回滚后按幂等返回既有结果。AI 调用在事务外（耗时长，不占数据库事务），
 * 失败时不落任何数据，状态停留 followup，可安全重试（T06 失败与回滚约定）。
 */

type DbClient = PrismaClient;

export interface DimensionScoreResult {
  dimension: string;
  rawScore: number;
  hintCount: number;
  coefficient: number;
  effectiveScore: number;
  diagnosisText: string | null;
}

export interface ScoreSessionResult {
  sessionId: string;
  state: "scored";
  scores: DimensionScoreResult[];
  feedback: { topIssueText: string; nextFocusText: string };
}

export interface ScoreSessionDeps {
  /** AI 评分实现（测试注入 mock；缺省走 MiMo 网关真实调用） */
  scoreWithRubric?: (input: RubricScoringInput) => Promise<RubricScoringOutput>;
}

/** 并发评分冲突标记：事务内守卫未命中时抛出以回滚，外层捕获后按幂等返回 */
class ConcurrentScoringError extends Error {}

/** 保留两位小数：避免 0.8 等系数带来的二进制浮点长尾落库 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 提取该题能力标签覆盖维度的 Rubric（BR-1：只评这些维度；顺序与能力标签一致） */
function extractRubricDimensions(question: Question): Record<string, string[]> {
  const tags = Array.isArray(question.abilityTags)
    ? question.abilityTags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const rubric = question.rubric as { dimensions?: Record<string, unknown> } | null;
  const dimensions: Record<string, string[]> = {};
  for (const tag of tags) {
    const points = rubric?.dimensions?.[tag];
    if (Array.isArray(points)) {
      dimensions[tag] = points.filter((p): p is string => typeof p === "string");
    }
  }
  if (Object.keys(dimensions).length === 0) {
    // 数据异常：导入管线已校验能力标签与 Rubric 一一对应（理论不可达）
    throw new ScoringError(CODES.QUESTION_RUBRIC_INVALID, 500, "题目 Rubric 与能力标签不匹配");
  }
  return dimensions;
}

/** 读取既有评分结果（幂等返回用）；无有效 scores 返回 null */
async function readExistingResult(
  db: DbClient,
  sessionId: string,
  abilityTags: string[],
): Promise<Omit<ScoreSessionResult, "sessionId" | "state"> | null> {
  const rows = await db.score.findMany({ where: { sessionId } });
  if (rows.length === 0) return null;
  // 返回顺序与能力标签一致（与首次评分返回对齐）；标签外记录兜底排最后
  const ordered = [...rows].sort((a, b) => {
    const ia = abilityTags.indexOf(a.dimension);
    const ib = abilityTags.indexOf(b.dimension);
    return (ia === -1 ? abilityTags.length : ia) - (ib === -1 ? abilityTags.length : ib);
  });
  const feedback = await db.sessionFeedback.findUnique({ where: { sessionId } });
  return {
    scores: ordered.map((row) => ({
      dimension: row.dimension,
      rawScore: row.rawScore,
      hintCount: row.hintCount,
      coefficient: row.coefficient,
      effectiveScore: row.effectiveScore,
      diagnosisText: row.diagnosisText,
    })),
    feedback: {
      topIssueText: feedback?.topIssueText ?? "",
      nextFocusText: feedback?.nextFocusText ?? "",
    },
  };
}

/** 防御性校验：AI 输出维度必须与题目覆盖维度一一对应（防半截落库） */
function assertOutputMatchesDimensions(
  output: RubricScoringOutput,
  rubricDimensions: Record<string, string[]>,
): void {
  const expected = Object.keys(rubricDimensions);
  const actual = output.dimensions.map((d) => d.dimension);
  const matched =
    actual.length === expected.length &&
    expected.every((dimension) => actual.includes(dimension));
  if (!matched) {
    throw new ScoringError(
      CODES.SCORING_OUTPUT_INVALID,
      500,
      "AI 评分输出维度与题目能力标签不一致",
    );
  }
}

/**
 * 触发会话评分：终答提交后调用（路由层/T07 接入）。
 * 幂等：重复触发返回既有结果（US-006：重复提交终答不重复计分）。
 */
export async function scoreSession(
  db: DbClient,
  sessionId: string,
  userId: string,
  deps: ScoreSessionDeps = {},
): Promise<ScoreSessionResult> {
  const session = await db.trainingSession.findUnique({
    where: { id: sessionId },
    include: { question: true },
  });
  if (!session || session.userId !== userId) {
    throw new ScoringError(CODES.SESSION_NOT_FOUND, 404, "训练会话不存在");
  }

  const rubricDimensions = extractRubricDimensions(session.question);

  // 幂等：已有有效评分 → 返回既有结果，不重复调 AI、不重复落库
  const existing = await readExistingResult(db, sessionId, Object.keys(rubricDimensions));
  if (existing) return { sessionId, state: "scored", ...existing };

  // 守卫：T05 约定终答落库后状态停留 followup；scored 前必须已提交终答
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
  // 状态机单一事实源校验（fail fast）：followup 经 MARK_SCORED 推进后恒为 scored
  nextState(session.state, "MARK_SCORED");

  // AI 评分（事务外）：解析失败/网关失败直接抛出，不落任何数据，可安全重试
  // 主测维度约定：extractRubricDimensions 按 abilityTags 顺序插入，首标签即本题主测维度
  const mainDimension = Object.keys(rubricDimensions)[0];
  const score = deps.scoreWithRubric ?? scoreWithRubric;
  const output = await score({
    mainDimension,
    mainQuestion: session.question.mainQuestion,
    rubricDimensions,
    firstAnswer: session.firstAnswer ?? "",
    followupQuestions: parseFollowupRecords(session.followups).map((f) => f.question),
    finalAnswer: session.finalAnswer,
  });
  assertOutputMatchesDimensions(output, rubricDimensions);

  // 有效分四元组（BR-1/BR-2 修订：系数复用 training 实现，含追问提示半价项，D22）
  const coefficient = independenceCoefficient(session.hintCount, session.followupHintCount);
  const scoredAt = new Date();

  try {
    return await db.$transaction(async (tx) => {
      // 原子推进状态：守卫条件保证并发下只有一方完成落库
      const advanced = await tx.trainingSession.updateMany({
        where: { id: sessionId, userId, state: "followup" },
        data: { state: "scored", scoredAt },
      });
      if (advanced.count === 0) throw new ConcurrentScoringError();

      await tx.score.createMany({
        data: output.dimensions.map((d) => ({
          sessionId,
          dimension: d.dimension,
          rawScore: d.rawScore,
          hintCount: session.hintCount,
          coefficient,
          effectiveScore: round2(d.rawScore * coefficient),
          diagnosisText: d.diagnosis,
        })),
      });
      await tx.sessionFeedback.create({
        data: {
          sessionId,
          topIssueText: output.topIssue,
          nextFocusText: output.nextFocus,
        },
      });
      // 画像联动（BR-6/FR-6）：以 scores 为事实源重算，同事务保证一致
      await refreshAbilityProfile(tx, userId, Object.keys(rubricDimensions));

      return {
        sessionId,
        state: "scored",
        scores: output.dimensions.map((d) => ({
          dimension: d.dimension,
          rawScore: d.rawScore,
          hintCount: session.hintCount,
          coefficient,
          effectiveScore: round2(d.rawScore * coefficient),
          diagnosisText: d.diagnosis,
        })),
        feedback: { topIssueText: output.topIssue, nextFocusText: output.nextFocus },
      };
    });
  } catch (error) {
    if (error instanceof ConcurrentScoringError) {
      // 并发另一方已完成评分：按幂等返回既有结果
      const fallback = await readExistingResult(db, sessionId, Object.keys(rubricDimensions));
      if (fallback) return { sessionId, state: "scored", ...fallback };
    }
    throw error;
  }
}
