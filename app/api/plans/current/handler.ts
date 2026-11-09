import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import { assertAbilityResultsVisible, BaselineRequiredError } from "@/server/modules/baseline/result-visibility";
import {
  getOrCreateCurrentPlan,
  getPlanProgress,
  PlanningError,
  toTrainingPlanView,
  type PlanningDeps,
} from "@/server/modules/planning";

/**
 * GET /api/plans/current（T29 / F5 / D30）：本周计划视图——首访懒生成（规则引擎取画像
 * 最低分维度，不用 AI）+ 计划视图 + 进度聚合。
 * 画像存在未知维度时返回 409 PROFILE_INCOMPLETE（待补测态，提示先完成基线测评，D35）；
 * 轻量 DB 端点不接 aiEndpointRateLimiter（T24 先例）；未登录 401。
 *
 * 工厂模式：测试注入 deps.now / 仓储桩；生产缺省真实实现。
 */
export function createCurrentGetHandler(deps: PlanningDeps = {}) {
  return async function GET(request: Request) {
    const user = await getRequestUser(prisma, request);
    if (!user) return unauthorized();
    try {
      await assertAbilityResultsVisible(prisma, user.id);
      const plan = await getOrCreateCurrentPlan(prisma, user.id, deps);
      const progress = await getPlanProgress(prisma, user.id, plan, deps);
      return jsonOk({ plan: toTrainingPlanView(plan), progress });
    } catch (error) {
      if (error instanceof BaselineRequiredError) {
        return jsonError(409, "BASELINE_REQUIRED", error.message);
      }
      if (error instanceof PlanningError) {
        return jsonError(error.httpStatus, error.code, error.message);
      }
      throw error;
    }
  };
}

