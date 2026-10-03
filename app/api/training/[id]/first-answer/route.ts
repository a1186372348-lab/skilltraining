import { z } from "zod";

import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { ensureRequestUser } from "@/server/lib/dev-identity";
import { prisma } from "@/server/lib/prisma";
import { TrainingError } from "@/server/modules/training/errors";
import { aiEndpointRateLimiter } from "@/server/modules/training/rate-limit";
import { submitFirstAnswer } from "@/server/modules/training/service";

const sessionIdSchema = z.uuid();

// 首答入参：非空、上限 1 万字（防滥用）
const bodySchema = z.object({
  answer: z.string().trim().min(1, "答案不能为空").max(10_000, "答案过长"),
});

/**
 * POST /api/training/:id/first-answer（US-005 / FR-4 / BR-4）：
 * 状态推进 → AI 产品总监追问（1~2 轮，不泄露 Rubric 要点）；
 * 提示入口随之永久关闭（D7）；重复提交幂等。AI 调用端点，启用限流（Prd.md 3.5）。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await ensureRequestUser(prisma, request);
  if (!user) return unauthorized();

  const limit = aiEndpointRateLimiter.check(`first-answer:${user.id}`);
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
    const result = await submitFirstAnswer(prisma, id, user.id, parsed.data.answer);
    return jsonOk(result);
  } catch (error) {
    if (error instanceof TrainingError) {
      return jsonError(error.httpStatus, error.code, error.message);
    }
    throw error;
  }
}
