import { z } from "zod";

import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import { assertAbilityResultsVisible, BaselineRequiredError } from "@/server/modules/baseline/result-visibility";
import {
  PlanningError,
  setCurrentPlanStatus,
  toTrainingPlanView,
  type PlanningDeps,
} from "@/server/modules/planning";

/**
 * POST /api/plans/reject（T29 / F5 / D33② / BR-V2-2）：拒绝/撤销本周计划。
 * body 经 zod 判别 action（reject→rejected / unreject→active）；幂等——已在目标态
 * 返回当前态不重复写库；无本周计划 404 PLAN_NOT_FOUND；未登录 401；非法 body 400。
 * 轻量 DB 端点不接 aiEndpointRateLimiter（T24 先例）。
 */

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reject") }),
  z.object({ action: z.literal("unreject") }),
]);

export function createRejectPostHandler(deps: PlanningDeps = {}) {
  return async function POST(request: Request) {
    const user = await getRequestUser(prisma, request);
    if (!user) return unauthorized();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "INVALID_JSON", "请求体不是合法 JSON");
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(400, "VALIDATION_FAILED", "action 须为 reject 或 unreject", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    try {
      await assertAbilityResultsVisible(prisma, user.id);
      const plan = await setCurrentPlanStatus(
        prisma,
        user.id,
        parsed.data.action === "reject" ? "rejected" : "active",
        deps,
      );
      return jsonOk({ plan: toTrainingPlanView(plan) });
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

