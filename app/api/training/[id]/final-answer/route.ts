import { after } from "next/server";
import { z } from "zod";

import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import {
  triggerSessionScoring,
  type TriggerSessionScoringDeps,
} from "@/server/modules/scoring/trigger";
import { TrainingError } from "@/server/modules/training/errors";
import { aiEndpointRateLimiter } from "@/server/modules/training/rate-limit";
import { submitFinalAnswer } from "@/server/modules/training/service";

const sessionIdSchema = z.uuid();

// T39：后台评分保活上限（Vercel Hobby 单请求最长 300s，覆盖评分真实延迟 35~49 秒）
export const maxDuration = 300;

const bodySchema = z.object({
  answer: z.string().trim().min(1, "答案不能为空").max(10_000, "答案过长"),
});

/**
 * POST /api/training/:id/final-answer：终答落库（final_answer + 时间戳）。
 * 幂等：重复提交不覆盖、不重复推进（US-006：重复提交终答不重复计分）。
 * 状态保持 followup——T36 / D38：提交成功即后台触发评分（fire-and-forget，
 * 不等结果、不影响响应；重复提交触发无害：scoreSession 幂等 + inflight 去重），
 * 评分完成后推进 scored。评分属 AI 调用，按 AI 端点标准启用限流。
 *
 * 工厂模式：测试注入 mock 评分实现（真实冒烟 0 次）；生产缺省走 AI 网关（DeepSeek，D39）。
 */
export function createFinalAnswerPostHandler(deps: TriggerSessionScoringDeps = {}) {
  return async function POST(
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
      // T36 / D38：终答提交成功即后台触发评分（基线题间并行评分的前提）
      // T39：注入 next/server 的 after 作 schedule，Serverless 下保活后台评分
      triggerSessionScoring(prisma, id, user.id, { ...deps, schedule: after });
      return jsonOk(result);
    } catch (error) {
      if (error instanceof TrainingError) {
        return jsonError(error.httpStatus, error.code, error.message);
      }
      throw error;
    }
  };
}

export const POST = createFinalAnswerPostHandler();
