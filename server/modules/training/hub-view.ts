import type { PrismaClient, TrainingSessionState } from "@prisma/client";

import { computeStreakDays, toDateKeyUtc } from "../dashboard/assemble";
import { parseAbilityTags } from "../history/view";

import { todayUtc } from "./service";

/**
 * 产品训练大厅视图（GET /api/training/hub 的数据载荷，T25 / D27）。
 *
 * 大厅 = 顶部「当前训练」卡三态 + 下方训练历史列表 + 侧栏连续训练天数：
 * - 当前卡状态机（优先级从上到下）：存在任何非基线未完成会话（取最新）→「进行中」；
 *   否则今日 daily 会话已 scored →「已完成」（附 ≤3 条维度有效分摘要）；
 *   否则今日无 daily 会话 →「未开始」；
 * - 历史列表：非基线会话 startedAt 倒序 ≤20 条（基线会话经 question.kind 排除，
 *   D26⑦/D27 同口径：基线有独立入口，不进大厅）；
 * - 连续训练天数：复用首页统计条同一口径与纯函数（有终答的会话日期，单一事实源）。
 *
 * FR-10 出口防线：rubric、hintTree 不查询、不出库（同历史模块查询纪律）。
 */

type DbClient = PrismaClient;

/** 历史列表固定条数（首版分页从简：固定条数 + 「加载更多」留空实现） */
export const HUB_HISTORY_LIMIT = 20;
/** 维度有效分摘要上限（当前卡得分条与历史行摘要同口径） */
export const HUB_SCORE_SUMMARY_LIMIT = 3;

/** 进行中会话的阶段（D27 状态机：reading/answering→作答中；followup 未交终答→追问中；已交终答未评分→评分中） */
export type HubSessionStage = "answering" | "followup" | "scoring";

/** 维度有效分摘要条目（当前卡与历史行共用） */
export interface HubScoreSummary {
  dimension: string;
  effectiveScore: number;
}

/** 当前训练卡三态 */
export type HubCurrentCard =
  | { kind: "in_progress"; sessionId: string; caseTitle: string; stage: HubSessionStage }
  | { kind: "not_started"; dateKey: string }
  | { kind: "completed"; sessionId: string; caseTitle: string; scores: HubScoreSummary[] };

/** 历史列表行 */
export interface HubHistoryItem {
  sessionId: string;
  caseTitle: string;
  /** 是否加练（D27④：加练并入历史列表，以「加练」徽章区分） */
  isExtra: boolean;
  state: TrainingSessionState;
  /** 已提交终答（前端据此区分「追问中 / 评分中」徽章） */
  hasFinalAnswer: boolean;
  abilityTags: string[];
  scores: HubScoreSummary[];
  /** 进入训练时间（ISO；前端本地时区格式化「今天 HH:mm / M月D日」） */
  startedAt: string;
}

/** GET /api/training/hub 的 data 负载 */
export interface TrainingHubView {
  current: HubCurrentCard;
  history: HubHistoryItem[];
  /** 连续训练天数（与首页统计条同口径） */
  streakDays: number;
}

/** 装配行（查询层 select 形状；question.abilityTags 为 jsonb 原值，装配时防御解析） */
export interface HubSessionRow {
  id: string;
  isExtra: boolean;
  state: TrainingSessionState;
  finalSubmittedAt: Date | null;
  startedAt: Date;
  question: { caseTitle: string; abilityTags: unknown };
  scores: { dimension: string; effectiveScore: number }[];
}

/**
 * 进行中会话阶段判定：reading/answering → 作答中；
 * followup 未交终答 → 追问中；已交终答（未评分）→ 评分中。
 * scored 不属进行中（调用方保证），防御兜底按作答中。
 */
export function hubSessionStage(
  state: TrainingSessionState,
  hasFinalAnswer: boolean,
): HubSessionStage {
  if (state === "followup") return hasFinalAnswer ? "scoring" : "followup";
  return "answering";
}

/** 得分摘要：按落库顺序取前 N 条（能力标签 2~4 个，摘要条宽有限统一 ≤3） */
function toScoreSummaries(
  scores: { dimension: string; effectiveScore: number }[],
): HubScoreSummary[] {
  return scores
    .slice(0, HUB_SCORE_SUMMARY_LIMIT)
    .map((score) => ({ dimension: score.dimension, effectiveScore: score.effectiveScore }));
}

/**
 * 当前训练卡三态判定（优先级从上到下）：
 * 1. 存在任何非基线未完成会话（查询层已取最新）→「进行中」；
 * 2. 今日 daily 会话已评分 →「已完成」；
 * 3. 否则 →「未开始」。
 * 注：今日 daily 存在但未评分时本身就是未完成会话，必先命中分支 1，分支 2 不冲突。
 */
export function resolveCurrentCard(input: {
  inProgress: HubSessionRow | null;
  todayDailyCompleted: HubSessionRow | null;
  todayKey: string;
}): HubCurrentCard {
  if (input.inProgress) {
    return {
      kind: "in_progress",
      sessionId: input.inProgress.id,
      caseTitle: input.inProgress.question.caseTitle,
      stage: hubSessionStage(input.inProgress.state, input.inProgress.finalSubmittedAt !== null),
    };
  }
  if (input.todayDailyCompleted) {
    return {
      kind: "completed",
      sessionId: input.todayDailyCompleted.id,
      caseTitle: input.todayDailyCompleted.question.caseTitle,
      scores: toScoreSummaries(input.todayDailyCompleted.scores),
    };
  }
  return { kind: "not_started", dateKey: input.todayKey };
}

/** 历史行映射：徽章字段、能力标签（防御解析）、≤3 条得分摘要、时间 ISO */
export function toHubHistoryItem(row: HubSessionRow): HubHistoryItem {
  return {
    sessionId: row.id,
    caseTitle: row.question.caseTitle,
    isExtra: row.isExtra,
    state: row.state,
    hasFinalAnswer: row.finalSubmittedAt !== null,
    abilityTags: parseAbilityTags(row.question.abilityTags),
    scores: toScoreSummaries(row.scores),
    startedAt: row.startedAt.toISOString(),
  };
}

/** 大厅装配所需字段（三处查询共用；rubric / hintTree 不查询、不出库，FR-10） */
const HUB_SESSION_SELECT = {
  id: true,
  isExtra: true,
  state: true,
  finalSubmittedAt: true,
  startedAt: true,
  question: { select: { caseTitle: true, abilityTags: true } },
  scores: { select: { dimension: true, effectiveScore: true } },
} as const;

/**
 * 当前训练卡数据源（T26 / D28②：首页与大厅共用同一查询 + 判定，单一事实源）：
 * 最新未完成非基线会话 + 今日已评分 daily 会话两查询 → resolveCurrentCard 三态判定。
 * 全部查询经 question.kind="daily" 排除基线会话（D19/D26⑦ 同口径：基线有独立入口）。
 * T38 / D40：进行中查询同时排除 abandoned——已终止会话不再占用当前卡（回到未开始态）。
 */
export async function getCurrentTrainingCard(
  db: DbClient,
  userId: string,
): Promise<HubCurrentCard> {
  const [inProgress, todayDailyCompleted] = await Promise.all([
    db.trainingSession.findFirst({
      where: { userId, state: { notIn: ["scored", "abandoned"] }, question: { kind: "daily" } },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: HUB_SESSION_SELECT,
    }),
    db.trainingSession.findFirst({
      where: {
        userId,
        date: todayUtc(),
        isExtra: false,
        state: "scored",
        question: { kind: "daily" },
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: HUB_SESSION_SELECT,
    }),
  ]);
  return resolveCurrentCard({ inProgress, todayDailyCompleted, todayKey: toDateKeyUtc(todayUtc()) });
}

/**
 * 装配大厅视图：当前训练卡（与首页共用 getCurrentTrainingCard，T26）+
 * 历史列表（≤20）+ 连续训练日期集，三路并行。
 * 历史与当前卡查询经 question.kind="daily" 排除基线会话（streak 日期集除外：
 * 与首页统计条同口径，基线作答同样计为训练日）。
 */
export async function getTrainingHubView(
  db: DbClient,
  userId: string,
): Promise<TrainingHubView> {
  const [current, historyRows, trainedDates] = await Promise.all([
    getCurrentTrainingCard(db, userId),
    db.trainingSession.findMany({
      where: { userId, question: { kind: "daily" } },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: HUB_HISTORY_LIMIT,
      select: HUB_SESSION_SELECT,
    }),
    db.trainingSession.findMany({
      where: { userId, finalAnswer: { not: null } },
      select: { date: true },
    }),
  ]);
  const todayKey = toDateKeyUtc(todayUtc());
  return {
    current,
    history: historyRows.map(toHubHistoryItem),
    streakDays: computeStreakDays(
      trainedDates.map((row) => toDateKeyUtc(row.date)),
      todayKey,
    ),
  };
}
