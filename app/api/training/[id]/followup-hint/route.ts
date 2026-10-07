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
import { requestFollowupHint } from "@/server/modules/training/service";

const sessionIdSchema = z.uuid();

// 入参：第几轮追问（D6 轮次硬上限 2，Service 层对不存在的轮次再兜底）
const bodySchema = z.object({
  round: z.number().int("round 必须为整数").min(1, "round 从 1 开始"),
});

/**
 * POST /api/training/:id/followup-hint（T19 / D22）：释放某轮追问的预生成提示。
 * 提示随追问生成时同一次 AI 调用预生成并落库，本端点只读库，无二次 AI 延迟；
 * 同一 round 幂等（重复请求返回已释放 hint，不重复计数）；响应携带按 BR-2
 * 修订公式重算的独立完成系数（追问提示每次 −0.05，共用 0.6 下限）。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await ensureRequestUser(prisma, request);
  if (!user) return unauthorized();

  const limit = aiEndpointRateLimiter.check(`followup-hint:${user.id}`);
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
    return jsonError(400, "VALIDATION_FAILED", "请求参数未通过校验", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  try {
    const result = await requestFollowupHint(prisma, id, user.id, parsed.data.round);
    return jsonOk(result);
  } catch (error) {
    if (error instanceof TrainingError) {
      return jsonError(error.httpStatus, error.code, error.message);
    }
    throw error;
  }
}
