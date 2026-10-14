import { jsonOk, unauthorized } from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import { getAbilityPageView } from "@/server/modules/profile/ability-page";

/**
 * 能力画像页视图（T09 / US-008 / FR-8）。
 * GET：返回全 8 维画像视图（已观测：分数/观察次数/趋势/状态标签/提示依赖分档/
 * 火花线序列；未观测：未知态）+ 顶部洞察（n/8 已了解 + 下一题优先方向）+
 * 整体提示依赖度。响应负载经 zod 校验（系统边界防御），统一响应封装。
 */
export async function GET(request: Request) {
  const user = await getRequestUser(prisma, request);
  if (!user) return unauthorized();
  return jsonOk(await getAbilityPageView(prisma, user.id));
}
