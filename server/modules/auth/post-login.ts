import type { PrismaClient } from "@prisma/client";

import { getBaselineStatus } from "@/server/modules/baseline/service";

/**
 * 登录落点分发：每次登录（魔法链接核销成功）后按用户当前状态决定落点，
 * 对应 PRD 首登链路「初始画像问卷 → 能力基线测评 → 画像揭晓（首页）」。
 *
 * 规则：
 * - 无 user_profiles 行（问卷未完成）→ "/onboarding"；
 * - 有画像行但基线测评未完成 → "/baseline"；
 * - 全部完成 → "/" 首页；
 * - 题库无上架基线题时 getBaselineStatus().required=false，天然回退首页。
 */

type DbClient = PrismaClient;

export type PostLoginPath = "/onboarding" | "/baseline" | "/";

export async function resolvePostLoginPath(db: DbClient, userId: string): Promise<PostLoginPath> {
  const profile = await db.userProfile.findUnique({ where: { userId } });
  if (!profile) return "/onboarding";
  const baseline = await getBaselineStatus(db, userId);
  return baseline.required ? "/baseline" : "/";
}
