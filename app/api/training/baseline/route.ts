import {
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import { getBaselineStatus } from "@/server/modules/baseline/service";

/**
 * GET /api/training/baseline（T17a / D19）：能力基线测评状态。
 * 供 /baseline 页开场判定与完成轮询：required=false 表示无需基线（已完成或题库无基线题）。
 * 全部评完时服务端幂等补写 baseline_completed_at（见 baseline 模块）。
 * 出口只下发题目 id 与标题，Rubric/提示树绝不下发（FR-10）。
 */
export async function GET(request: Request) {
  const user = await getRequestUser(prisma, request);
  if (!user) return unauthorized();

  const status = await getBaselineStatus(prisma, user.id);
  return jsonOk({
    required: status.required,
    total: status.total,
    doneCount: status.doneCount,
    nextQuestion: status.nextQuestion
      ? { id: status.nextQuestion.id, caseTitle: status.nextQuestion.caseTitle }
      : null,
    completedAt: status.completedAt?.toISOString() ?? null,
  });
}
