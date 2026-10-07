import type { PrismaClient } from "@prisma/client";

import { getAbilityProfileView } from "@/server/modules/profile/ability";
import { getCurrentTrainingCard } from "@/server/modules/training/hub-view";
import { todayUtc } from "@/server/modules/training/service";

import {
  buildAbilityOverview,
  buildStatsCard,
  toDateKeyUtc,
  truncateText,
} from "./assemble";
import type {
  AbilityOverviewData,
  DashboardView,
  LatestDiagnosisData,
  StatsCardData,
} from "./contract";

/**
 * 首页仪表盘装配服务（T08 / US-002）。
 *
 * 四个卡片（统计条 / 当前训练 / 能力总览 / 最近诊断）独立装配：
 * 单卡失败仅记录审计日志并降级为 null（前端空态），不拖垮整页
 * （T08 失败与回滚约定）。当前训练卡复用 training 模块大厅同源查询
 * （T26 / D28②：getCurrentTrainingCard 单一事实源，首页与大厅永不漂移）。
 */

type DbClient = PrismaClient;

/** 最近诊断展示的最大长度（超出截断追加省略号） */
export const DIAGNOSIS_MAX_LENGTH = 90;

/** 统计条：有终答（final_answer 非空）的会话日期 → 连续天数 + 本周进度 */
async function loadStats(db: DbClient, userId: string): Promise<StatsCardData> {
  const sessions = await db.trainingSession.findMany({
    where: { userId, finalAnswer: { not: null } },
    select: { date: true },
  });
  return buildStatsCard(
    sessions.map((session) => toDateKeyUtc(session.date)),
    toDateKeyUtc(todayUtc()),
  );
}

/** 能力总览：全 8 维画像视图（未观测补齐未知态）→ 条形 + 待解锁 */
async function loadAbility(db: DbClient, userId: string): Promise<AbilityOverviewData> {
  return buildAbilityOverview(await getAbilityProfileView(db, userId));
}

/** 最近一条诊断：最新已评分会话的 top_issue_text，截断展示 */
async function loadLatestDiagnosis(
  db: DbClient,
  userId: string,
): Promise<LatestDiagnosisData | null> {
  const row = await db.sessionFeedback.findFirst({
    where: { session: { userId, scoredAt: { not: null } } },
    orderBy: { session: { scoredAt: "desc" } },
    select: {
      sessionId: true,
      topIssueText: true,
      session: { select: { date: true } },
    },
  });
  if (!row) return null;
  return {
    sessionId: row.sessionId,
    text: truncateText(row.topIssueText, DIAGNOSIS_MAX_LENGTH),
    dateKey: toDateKeyUtc(row.session.date),
  };
}

/** 单卡加载兜底：失败记审计日志并降级为 null（前端空态），不影响其他卡 */
async function safeCard<T>(card: string, load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "dashboard.card_load_failed",
        card,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

/** 装配首页仪表盘视图：四卡并行、各自独立降级 */
export async function getDashboardView(db: DbClient, userId: string): Promise<DashboardView> {
  const [stats, currentTraining, ability, latestDiagnosis] = await Promise.all([
    safeCard("stats", () => loadStats(db, userId)),
    safeCard("currentTraining", () => getCurrentTrainingCard(db, userId)),
    safeCard("ability", () => loadAbility(db, userId)),
    safeCard("latestDiagnosis", () => loadLatestDiagnosis(db, userId)),
  ]);
  return { todayDateKey: toDateKeyUtc(todayUtc()), stats, currentTraining, ability, latestDiagnosis };
}
