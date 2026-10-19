import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import {
  BASELINE_ERROR_CODES,
  BaselineError,
} from "@/server/modules/baseline/errors";
import {
  getBaselineStatus,
  getOrCreateBaselineSession,
} from "@/server/modules/baseline/service";
import { TrainingError } from "@/server/modules/training/errors";
import {
  getLatestDailySession,
  getOrCreateTodaySession,
} from "@/server/modules/training/service";
import { toTodayView } from "@/server/modules/training/today-view";

/**
 * GET /api/training/today（US-003）：今日案例 / 训练重点 / 主问题 / 资料。
 * FR-10：toTodayView 为出口防线，Rubric 与未释放提示层绝不下发。
 * T17a / D19 门禁：能力基线未完成时返回基线会话（kind=baseline + 进度，
 * 进度口径为已作答题数，T36 / D38），训练闭环（提示/追问/评分/系数规则）与日常题完全一致。
 * T36 / D38 门禁边界：全部已作答未全部评完（required 且 nextQuestion=null）时
 * 返回 409 BASELINE_SCORING_PENDING——画像未齐，不得落入日常题分支，前端挡回 /baseline 收尾页。
 * T21 会话选择：基线门禁之后，当天已有非基线会话（每日或加练）时返回最近一个
 * （startedAt 倒序，进行中自然优先）；没有才创建每日一题。
 */
export async function GET(request: Request) {
  const user = await getRequestUser(prisma, request);
  if (!user) return unauthorized();

  try {
    const baselineStatus = await getBaselineStatus(prisma, user.id);
    // T36 / D38：全部已作答、评分进行中——先于一切日常分支检查（画像未齐，选题无依据）
    if (baselineStatus.required && !baselineStatus.nextQuestion) {
      throw new BaselineError(
        BASELINE_ERROR_CODES.BASELINE_SCORING_PENDING,
        409,
        "基线评分生成中，完成后自动解锁日常训练",
      );
    }
    if (baselineStatus.required && baselineStatus.nextQuestion) {
      try {
        const { session, question, status } = await getOrCreateBaselineSession(prisma, user.id);
        return jsonOk(
          toTodayView(session, question, {
            kind: "baseline",
            baselineProgress: { done: status.answeredCount, total: status.total },
          }),
        );
      } catch (error) {
        // 竞态：两次检查间隙基线已完成 → 按日常训练继续
        if (!(error instanceof BaselineError)) throw error;
      }
    }

    // T21：加练进行中/全部完成时最近会话已在库，直接返回（不重复创建每日一题）
    const latest = await getLatestDailySession(prisma, user.id);
    if (latest) return jsonOk(toTodayView(latest.session, latest.question));

    const { session, question } = await getOrCreateTodaySession(prisma, user.id);
    return jsonOk(toTodayView(session, question));
  } catch (error) {
    if (error instanceof TrainingError || error instanceof BaselineError) {
      return jsonError(error.httpStatus, error.code, error.message);
    }
    throw error;
  }
}
