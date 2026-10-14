import { z } from "zod";

import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import { TrainingError } from "@/server/modules/training/errors";
import { getSessionTodayView } from "@/server/modules/training/service";

const sessionIdSchema = z.uuid();

/**
 * GET /api/training/:id（T25 / D27）：单会话工作台载荷。
 * 复用 today 视图构建器按 sessionId 取，与 GET /api/training/today 载荷同构
 *（FR-10 出口防线不变）；历史列表中「作答中」的旧会话据此点回继续。
 * 仅限本人会话：他人与不存在一律 404（不泄露存在性）；
 * 基线会话（question.kind=baseline）拒绝：409 BASELINE_SESSION，前端据此重定向 /baseline。
 */
export async function GET(
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
    return jsonOk(await getSessionTodayView(prisma, id, user.id));
  } catch (error) {
    if (error instanceof TrainingError) {
      return jsonError(error.httpStatus, error.code, error.message);
    }
    throw error;
  }
}
