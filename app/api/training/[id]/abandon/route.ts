import { z } from "zod";

import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import { TrainingError } from "@/server/modules/training/errors";
import { aiEndpointRateLimiter } from "@/server/modules/training/rate-limit";
import { abandonSession } from "@/server/modules/training/service";

const sessionIdSchema = z.uuid();

/**
 * POST /api/training/:id/abandon（T38 / D40：训练终止与重启）。
 * 终止当前会话（状态推进 abandoned，非物理删除），供「当前训练」卡「重启训练」调用。
 * 守卫（D40④）：仅未提交终答的日常会话（含加练）可终止——
 * 基线会话 409 BASELINE_SESSION、已提交终答 409 FINAL_ANSWER_ALREADY_SUBMITTED、
 * 已评分 409 SESSION_ALREADY_SCORED；幂等：已 abandoned 返回成功。
 * 仅限本人会话：他人与不存在一律 404（不泄露存在性）；
 * 鉴权与限流模式与既有训练端点一致（Prd.md 3.5）；无 AI 调用。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getRequestUser(prisma, request);
  if (!user) return unauthorized();

  const limit = aiEndpointRateLimiter.check(`abandon:${user.id}`);
  if (!limit.allowed) {
    return jsonError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试", {
      retryAfterSeconds: limit.retryAfterSeconds,
    });
  }

  const { id } = await context.params;
  const parsed = sessionIdSchema.safeParse(id);
  if (!parsed.success) {
    return jsonError(400, "INVALID_SESSION_ID", "会话 id 不合法");
  }

  try {
    const result = await abandonSession(prisma, id, user.id);
    return jsonOk({ sessionId: id, state: result.state });
  } catch (error) {
    if (error instanceof TrainingError) {
      return jsonError(error.httpStatus, error.code, error.message);
    }
    throw error;
  }
}
