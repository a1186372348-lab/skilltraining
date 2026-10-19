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
import { retryFollowups } from "@/server/modules/training/service";

const sessionIdSchema = z.uuid();

/**
 * POST /api/training/:id/followup-retry（T37 / D39）：追问生成失败后的用户侧重试。
 * - 仅失败态可调（state=followup、已提交首答、未提交终答、followups 为空数组）；
 * - 幂等：followups 非空时直接返回既有追问，不覆盖、不重复调 AI；
 * - 再次失败返回 200 + 空 followups（语义与首答一致，前端按失败态处理）；
 * - AI 调用端点，启用限流（Prd.md 3.5）。无请求体。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getRequestUser(prisma, request);
  if (!user) return unauthorized();

  const limit = aiEndpointRateLimiter.check(`followup-retry:${user.id}`);
  if (!limit.allowed) {
    return jsonError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试", {
      retryAfterSeconds: limit.retryAfterSeconds,
    });
  }

  const { id } = await context.params;
  const idParsed = sessionIdSchema.safeParse(id);
  if (!idParsed.success) {
    return jsonError(400, "INVALID_SESSION_ID", "会话 id 不合法");
  }

  try {
    const result = await retryFollowups(prisma, id, user.id);
    return jsonOk(result);
  } catch (error) {
    if (error instanceof TrainingError) {
      return jsonError(error.httpStatus, error.code, error.message);
    }
    throw error;
  }
}
