import { z } from "zod";

import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import { submitFeedbackSurvey } from "@/server/modules/feedback/survey";
import { ScoringError } from "@/server/modules/scoring/errors";

const starSchema = z.number().int("星级须为整数").min(1, "星级最低 1 分").max(5, "星级最高 5 分");

const bodySchema = z.object({
  sessionId: z.uuid(),
  /** 训练后问 1：反馈是否说清问题（1~5） */
  q1Clarity: starSchema,
  /** 训练后问 2：下一步是否明确（1~5） */
  q2Next: starSchema,
  /** 周期性一问（D16：每 5 次已评分训练触发；非触发周期携带会被忽略） */
  periodicQ3: starSchema.optional(),
});

/** 对外错误文案：按 code 固定映射，不泄露内部细节（Prd.md 3.5） */
const SAFE_MESSAGES: Record<string, string> = {
  SESSION_NOT_FOUND: "训练会话不存在",
  SESSION_STATE_INVALID: "评分未完成，暂不能提交问卷",
};

/**
 * POST /api/feedback-survey：感知问卷落库（T07 / US-007 / FR-7 / D16）。
 * 两问 1~5 分写 feedback_surveys；每 5 次已评分训练追加周期性一问
 * （按该用户 scored 会话计数判定，响应返回 needsPeriodicQ3 供前端渲染第三问）。
 * 幂等：同会话重复提交不覆盖、不重复落库（可安全重试）。
 */
export async function POST(request: Request) {
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
    return jsonError(400, "VALIDATION_FAILED", "问卷内容未通过校验", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  try {
    const result = await submitFeedbackSurvey(
      prisma,
      parsed.data.sessionId,
      user.id,
      parsed.data,
    );
    return jsonOk(result);
  } catch (error) {
    if (error instanceof ScoringError) {
      return jsonError(
        error.httpStatus,
        error.code,
        SAFE_MESSAGES[error.code] ?? "问卷提交失败，请稍后再试",
      );
    }
    throw error;
  }
}
