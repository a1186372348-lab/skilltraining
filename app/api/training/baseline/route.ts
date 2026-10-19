import {
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import { getBaselineStatus } from "@/server/modules/baseline/service";
import {
  triggerSessionScoring,
  type TriggerSessionScoringDeps,
} from "@/server/modules/scoring/trigger";

/**
 * GET /api/training/baseline（T17a / D19；T36 / D38）：能力基线测评状态。
 * 供 /baseline 页开场判定、作答推进轮询与收尾页轮询：
 * required=false 表示无需基线（已完成或题库无基线题）；
 * answeredCount（已作答）驱动题间推进，doneCount（已评分）驱动收尾页揭晓进度。
 * 全部评完时服务端幂等补写 baseline_completed_at（见 baseline 模块）。
 * T36 自愈通道：读取状态后，对「已提交终答且未评分」的基线会话逐个补触发后台评分
 * （终答提交即触发失败时的重试兜底；inflight 去重 + scoreSession 幂等，低频轮询安全）。
 * 出口只下发题目 id 与标题，Rubric/提示树与待评分会话 id 绝不下发（FR-10）。
 *
 * 工厂模式：测试注入 mock 评分实现（真实冒烟 0 次）；生产缺省走 AI 网关（DeepSeek，D39）。
 */
export function createBaselineGetHandler(deps: TriggerSessionScoringDeps = {}) {
  return async function GET(request: Request) {
    const user = await getRequestUser(prisma, request);
    if (!user) return unauthorized();

    const status = await getBaselineStatus(prisma, user.id);
    for (const sessionId of status.pendingScoringSessionIds) {
      triggerSessionScoring(prisma, sessionId, user.id, deps);
    }
    return jsonOk({
      required: status.required,
      total: status.total,
      answeredCount: status.answeredCount,
      doneCount: status.doneCount,
      nextQuestion: status.nextQuestion
        ? { id: status.nextQuestion.id, caseTitle: status.nextQuestion.caseTitle }
        : null,
      completedAt: status.completedAt?.toISOString() ?? null,
    });
  };
}

export const GET = createBaselineGetHandler();
