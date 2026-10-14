import {
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import { getTrainingHubView } from "@/server/modules/training/hub-view";

/**
 * GET /api/training/hub（T25 / D27）：产品训练大厅载荷。
 * data 含当前训练卡三态、训练历史（非基线会话，startedAt 倒序 ≤20 条）、
 * 连续训练天数（与首页统计条同口径）。
 * 轻量 DB 查询、非 AI 端点，不接 aiEndpointRateLimiter（参照 /api/training/today）。
 */
export async function GET(request: Request) {
  const user = await getRequestUser(prisma, request);
  if (!user) return unauthorized();
  return jsonOk(await getTrainingHubView(prisma, user.id));
}
