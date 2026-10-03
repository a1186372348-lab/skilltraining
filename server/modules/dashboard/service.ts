import type { PrismaClient } from "@prisma/client";

import { getAbilityProfileView } from "@/server/modules/profile/ability";
import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";
import { getOrCreateTodaySession, todayUtc } from "@/server/modules/training/service";

import {
  buildAbilityOverview,
  buildStatsCard,
  buildTodayTaskCard,
  toDateKeyUtc,
  truncateText,
} from "./assemble";
import type {
  AbilityOverviewData,
  DashboardView,
  LatestDiagnosisData,
  StatsCardData,
  TodayTaskCardData,
} from "./contract";

/**
 * 首页仪表盘装配服务（T08 / US-002）。
 *
 * 四个卡片（统计条 / 今日任务 / 能力总览 / 最近诊断）独立装配：
 * 单卡失败仅记录审计日志并降级为 null（前端空态），不拖垮整页
 * （T08 失败与回滚约定）。今日任务卡复用 training 模块的每日一题会话
 * （与 /api/training/today 同源，选题逻辑保持单一事实源，T11 只改一处）。
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

/** 今日任务卡：复用每日一题会话；「为什么是它」占位规则需要未解锁维度 */
async function loadTodayTask(db: DbClient, userId: string): Promise<TodayTaskCardData> {
  const { session, question } = await getOrCreateTodaySession(db, userId);
  const observedRows = await db.abilityProfile.findMany({
    where: { userId, currentScore: { not: null } },
    select: { dimension: true },
  });
  const observed = new Set(observedRows.map((row) => row.dimension));
  return buildTodayTaskCard({
    sessionId: session.id,
    state: session.state,
    finalSubmittedAt: session.finalSubmittedAt,
    caseTitle: question.caseTitle,
    mainQuestion: question.mainQuestion,
    abilityTags: question.abilityTags,
    unobservedDimensions: ABILITY_DIMENSIONS.filter((dimension) => !observed.has(dimension)),
  });
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
  const [stats, todayTask, ability, latestDiagnosis] = await Promise.all([
    safeCard("stats", () => loadStats(db, userId)),
    safeCard("todayTask", () => loadTodayTask(db, userId)),
    safeCard("ability", () => loadAbility(db, userId)),
    safeCard("latestDiagnosis", () => loadLatestDiagnosis(db, userId)),
  ]);
  return { todayDateKey: toDateKeyUtc(todayUtc()), stats, todayTask, ability, latestDiagnosis };
}
