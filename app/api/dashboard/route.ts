import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import { dashboardViewSchema } from "@/server/modules/dashboard/contract";
import { getDashboardView } from "@/server/modules/dashboard/service";

/**
 * GET /api/dashboard（T08 / US-002）：首页仪表盘装配。
 * 四卡独立装配、单卡失败降级空态；出口经 zod 边界校验（快速失败）。
 */
export async function GET(request: Request) {
  const user = await getRequestUser(prisma, request);
  if (!user) return unauthorized();

  const view = await getDashboardView(prisma, user.id);
  const parsed = dashboardViewSchema.safeParse(view);
  if (!parsed.success) {
    console.error(
      JSON.stringify({
        event: "dashboard.view_invalid",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      }),
    );
    return jsonError(500, "DASHBOARD_VIEW_INVALID", "仪表盘数据装配异常");
  }
  return jsonOk(parsed.data);
}
