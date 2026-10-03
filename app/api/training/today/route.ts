import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { ensureRequestUser } from "@/server/lib/dev-identity";
import { prisma } from "@/server/lib/prisma";
import { TrainingError } from "@/server/modules/training/errors";
import { getOrCreateTodaySession } from "@/server/modules/training/service";
import { toTodayView } from "@/server/modules/training/today-view";

/**
 * GET /api/training/today（US-003）：今日案例 / 训练重点 / 主问题 / 资料。
 * FR-10：toTodayView 为出口防线，Rubric 与未释放提示层绝不下发。
 */
export async function GET(request: Request) {
  const user = await ensureRequestUser(prisma, request);
  if (!user) return unauthorized();

  try {
    const { session, question } = await getOrCreateTodaySession(prisma, user.id);
    return jsonOk(toTodayView(session, question));
  } catch (error) {
    if (error instanceof TrainingError) {
      return jsonError(error.httpStatus, error.code, error.message);
    }
    throw error;
  }
}
