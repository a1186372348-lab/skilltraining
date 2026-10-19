import { z } from "zod";

import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import { TrainingError } from "@/server/modules/training/errors";
import { requestHint } from "@/server/modules/training/service";

// 会话 id 必须为 uuid（zod 入参校验，Prd.md 3.5）
const sessionIdSchema = z.uuid();

/**
 * POST /api/training/:id/hint（US-004 / FR-3）：释放下一层提示（共 5 层）。
 * 响应携带当前独立完成系数（D12 透明化）；首次提交后 409 拒绝（D7）。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getRequestUser(prisma, request);
  if (!user) return unauthorized();

  const { id } = await context.params;
  const parsed = sessionIdSchema.safeParse(id);
  if (!parsed.success) {
    return jsonError(400, "INVALID_SESSION_ID", "会话 id 不合法");
  }

  try {
    const result = await requestHint(prisma, id, user.id);
    return jsonOk(result);
  } catch (error) {
    if (error instanceof TrainingError) {
      return jsonError(error.httpStatus, error.code, error.message);
    }
    throw error;
  }
}
