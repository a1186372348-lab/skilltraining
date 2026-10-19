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
 *   followup），finally 释放标记，下一次触发自动重试。
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
  void run(db, sessionId, userId, deps)
    .catch((error: unknown) => {
      // T06 约定：AI 失败不落任何数据，状态停留 followup，可安全重试
      console.error(`[scoring] 会话 ${sessionId} 后台评分失败，等待下一次触发重试`, error);
    })
    .finally(() => {
      scoringInflight.delete(sessionId);
    });
}
