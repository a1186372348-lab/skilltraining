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
import { submitFinalAnswer } from "@/server/modules/training/service";

const sessionIdSchema = z.uuid();

const bodySchema = z.object({
  answer: z.string().trim().min(1, "答案不能为空").max(10_000, "答案过长"),
});

/**
 * POST /api/training/:id/final-answer：终答落库（final_answer + 时间戳）。
 * 幂等：重复提交不覆盖、不重复推进（US-006：重复提交终答不重复计分）。
 * 状态保持 followup——【T06 接入点】评分由 T06 完成并推进 scored，
 * 届时本接口将触发评分 AI 调用，故提前按 AI 端点标准启用限流。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getRequestUser(prisma, request);
  if (!user) return unauthorized();

  const limit = aiEndpointRateLimiter.check(`final-answer:${user.id}`);
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "请求体不是合法 JSON");
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "VALIDATION_FAILED", "答案内容未通过校验", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  try {
    const result = await submitFinalAnswer(prisma, id, user.id, parsed.data.answer);
    return jsonOk(result);
  } catch (error) {
    if (error instanceof TrainingError) {
      return jsonError(error.httpStatus, error.code, error.message);
    }
    throw error;
  }
}
