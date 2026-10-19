import { jsonOk, unauthorized } from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import { getScoreNotifications } from "@/server/modules/training/score-notifications";

/**
 * GET /api/training/score-notifications（T24 / Prd.md D26）：
 * 当前登录用户的评分完成/评分波动可通知项，供全局通知组件每 10 秒轮询。
 * 轻量 DB 查询、非 AI 端点，不接 aiEndpointRateLimiter（参照 /api/training/today）；
 * 未登录 401，客户端静默忽略、下一轮再试。
 */
export async function GET(request: Request) {
  const user = await getRequestUser(prisma, request);
  if (!user) return unauthorized();

  return jsonOk(await getScoreNotifications(prisma, user.id));
}
