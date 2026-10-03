import { z } from "zod";

import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { ensureRequestUser } from "@/server/lib/dev-identity";
import { prisma } from "@/server/lib/prisma";
import { HistoryError } from "@/server/modules/history/errors";
import { getHistoryDetail } from "@/server/modules/history/view";

const sessionIdSchema = z.uuid();

/**
 * GET /api/history/:id（T10 / US-009 / FR-9）：训练历史详情回放。
 * data 含案例、两版答案、提示使用（层数+时间）、追问对话记录、评分四元组、
 * 反馈（最需优化问题+下一步）；缺失字段以 missing 标记而非报错；
 * 他人记录与不存在记录一律 404（不泄露存在性）。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await ensureRequestUser(prisma, request);
  if (!user) return unauthorized();

  const { id } = await context.params;
  const idParsed = sessionIdSchema.safeParse(id);
  if (!idParsed.success) {
    return jsonError(400, "INVALID_SESSION_ID", "会话 id 不合法");
  }

  try {
    return jsonOk(await getHistoryDetail(prisma, id, user.id));
  } catch (error) {
    if (error instanceof HistoryError) {
      return jsonError(error.httpStatus, error.code, "训练记录不存在");
    }
    throw error;
  }
}
