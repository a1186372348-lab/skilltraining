import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import { TrainingError } from "@/server/modules/training/errors";
import { aiEndpointRateLimiter } from "@/server/modules/training/rate-limit";
import { getOrCreateExtraSession } from "@/server/modules/training/service";

/**
 * POST /api/training/extra（T21 / Prd.md D3：加练同等计入画像）：
 * 创建或复用加练会话，返回 { sessionId }。
 * 当天存在未提交终答的非基线会话时幂等复用（防连点重复建题）；
 * 鉴权与限流模式与既有训练端点一致（Prd.md 3.5：接口级统一限流兜底加练滥用）。
 */
export async function POST(request: Request) {
  const user = await getRequestUser(prisma, request);
  if (!user) return unauthorized();

  const limit = aiEndpointRateLimiter.check(`extra:${user.id}`);
  if (!limit.allowed) {
    return jsonError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试", {
      retryAfterSeconds: limit.retryAfterSeconds,
    });
  }

  try {
    const { session } = await getOrCreateExtraSession(prisma, user.id);
    return jsonOk({ sessionId: session.id });
  } catch (error) {
    if (error instanceof TrainingError) {
      return jsonError(error.httpStatus, error.code, error.message);
    }
    throw error;
  }
}
