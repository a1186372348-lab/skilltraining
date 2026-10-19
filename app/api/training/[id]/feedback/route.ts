import { z } from "zod";

import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import {
  getFeedbackView,
  type FeedbackViewDeps,
} from "@/server/modules/feedback/view";
import { ScoringError } from "@/server/modules/scoring/errors";
import { aiEndpointRateLimiter } from "@/server/modules/training/rate-limit";

const sessionIdSchema = z.uuid();

/** 对外错误文案：按 code 固定映射，不泄露 Rubric/评分 prompt 等内部细节（Prd.md 3.5） */
const SAFE_MESSAGES: Record<string, string> = {
  SESSION_NOT_FOUND: "训练会话不存在",
  SESSION_STATE_INVALID: "作答流程未走完，暂不能查看反馈",
  FINAL_ANSWER_REQUIRED: "请先提交最终答案",
  QUESTION_RUBRIC_INVALID: "题目数据异常，请稍后再试",
  SCORING_OUTPUT_INVALID: "评分生成失败，请稍后再试",
};

/**
 * GET /api/training/:id/feedback：训练反馈视图（T07 / US-007 / FR-7）。
 * 懒触发评分（幂等，可安全重复调用）：未评分时后台触发 scoreSession 并立即
 * 返回 { status: "scoring" } 供前端轮询（真实延迟 35~49 秒，异步等待设计）；
 * 已评分返回 { status: "ready", scores 四元组, topIssueText, nextFocusText, survey }。
 * 评分属 AI 调用端点，按 Prd.md 3.5 启用限流。
 *
 * 工厂模式：测试注入 mock 评分实现（真实冒烟 0 次）；生产缺省走 AI 网关（DeepSeek，D39）。
 */
export function createFeedbackGetHandler(deps: FeedbackViewDeps = {}) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) {
    const user = await getRequestUser(prisma, request);
    if (!user) return unauthorized();

    const limit = aiEndpointRateLimiter.check(`feedback:${user.id}`);
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
      return jsonOk(await getFeedbackView(prisma, id, user.id, deps));
    } catch (error) {
      if (error instanceof ScoringError) {
        return jsonError(
          error.httpStatus,
          error.code,
          SAFE_MESSAGES[error.code] ?? "反馈数据生成失败，请稍后再试",
        );
      }
      throw error;
    }
  };
}

export const GET = createFeedbackGetHandler();
