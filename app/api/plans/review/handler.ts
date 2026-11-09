import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import { assertAbilityResultsVisible, BaselineRequiredError } from "@/server/modules/baseline/result-visibility";
import {
  getOrGenerateWeeklyReview,
  toWeeklyReviewView,
  type PlanningDeps,
} from "@/server/modules/planning";

/**
 * GET /api/plans/review（T29 / F5 / 蓝图 §2.4）：周回顾——周日及之后首访懒生成
 * （完成天数 + 主攻维度有效分变化，口径与 ability.ts 有效分事实源一致）并将该期计划
 * 归档 completed；周日前返回未生成态（200 + review=null）。
 * 轻量 DB 端点不接 aiEndpointRateLimiter（T24 先例）；未登录 401。
 *
 * 工厂模式：测试注入 deps.now 控制周日边界；生产缺省真实实现。
 */
export function createReviewGetHandler(deps: PlanningDeps = {}) {
  return async function GET(request: Request) {
    const user = await getRequestUser(prisma, request);
    if (!user) return unauthorized();
    try {
      await assertAbilityResultsVisible(prisma, user.id);
      const review = await getOrGenerateWeeklyReview(prisma, user.id, deps);
      return jsonOk({ review: review ? toWeeklyReviewView(review) : null });
    } catch (error) {
      if (error instanceof BaselineRequiredError) {
        return jsonError(409, "BASELINE_REQUIRED", error.message);
      }
      throw error;
    }
  };
}

