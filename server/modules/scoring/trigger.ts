import type { PrismaClient } from "@prisma/client";

import { scoreSession, type ScoreSessionDeps } from "./service";

/**
 * 后台评分触发（T36 / D38：自 feedback/view.ts 抽为共享入口）。
 *
 * 调用方：反馈页懒触发（T07）、终答提交即触发（T36）、基线状态查询补触发自愈（T36）。
 * 语义：
 * - fire-and-forget：不阻塞调用方响应，评分真实延迟 35~49 秒（R5）；
 * - 进程内 inflight 集合去重（与限流器同款的 V1 单实例前提），进行中的会话
 *   重复触发不重复调 AI；scoreSession 本身幂等，完成后的重复触发也安全；
 * - 失败仅 console.error 不落库（T06 约定：AI 失败不落任何数据，状态停留
 *   followup），finally 释放标记，下一次触发自动重试；
 * - 调度方式可注入（T39：Vercel Serverless 响应结束后函数冻结，fire-and-forget
 *   会被杀掉）：路由层注入 Next.js after 作为 schedule 保活后台任务；缺省
 *   （本地开发与测试）维持 fire-and-forget，行为不变。本模块不依赖 Next，
 *   schedule 仅是「接收任务并负责驱动执行」的抽象。
 */

type DbClient = PrismaClient;

export interface TriggerSessionScoringDeps extends ScoreSessionDeps {
  /** 评分入口（测试注入 mock；缺省走 T06 公开入口 scoreSession） */
  scoreSession?: (
    db: DbClient,
    sessionId: string,
    userId: string,
    deps: ScoreSessionDeps,
  ) => Promise<unknown>;
  /**
   * 后台任务调度器（T39）：Serverless 环境由路由层注入 Next.js after 保活，
   * 评分任务经其调度执行；缺省维持 fire-and-forget（void 直接发起）。
   */
  schedule?: (task: () => Promise<void>) => void;
}

/** 评分进行中的会话集合（进程内；防并发触发重复调 AI） */
const scoringInflight = new Set<string>();

/** 后台触发评分：进行中已存在则跳过；失败仅记录日志，不落库，待下一次触发重试 */
export function triggerSessionScoring(
  db: DbClient,
  sessionId: string,
  userId: string,
  deps: TriggerSessionScoringDeps = {},
): void {
  if (scoringInflight.has(sessionId)) return;
  scoringInflight.add(sessionId);
  const run = deps.scoreSession ?? scoreSession;
  const task = async (): Promise<void> => {
    await run(db, sessionId, userId, deps)
      .catch((error: unknown) => {
        // T06 约定：AI 失败不落任何数据，状态停留 followup，可安全重试
        console.error(`[scoring] 会话 ${sessionId} 后台评分失败，等待下一次触发重试`, error);
      })
      .finally(() => {
        scoringInflight.delete(sessionId);
      });
  };
  // T39：注入 schedule 时由其调度执行（Serverless 保活）；缺省维持 fire-and-forget
  if (deps.schedule) {
    deps.schedule(task);
    return;
  }
  void task();
}
