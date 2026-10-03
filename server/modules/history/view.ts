import type { PrismaClient, TrainingSessionState } from "@prisma/client";

import {
  parseFollowupRecords,
  type FollowupRecord,
} from "@/server/modules/training/today-view";

import { HISTORY_ERROR_CODES as CODES, HistoryError } from "./errors";
import {
  countHistorySessions,
  findHistorySessionDetail,
  findHistorySessionPage,
} from "./repository";

/**
 * 训练历史视图装配（T10 / US-009 / FR-9，Prd.md 2.3 页面 P5）。
 *
 * FR-10 出口防线：rubric、hintTree 一律不进入历史视图（repository 层不查询，
 * 本层不装配）；提示只回放"层数 + 时间"（hint_events 落库事实），不下发提示文案。
 *
 * 失败与回滚（任务契约）：单条记录数据缺失时标记缺失字段（missing），
 * 而非整页报错——装配函数对 jsonb 脏数据一律防御性解析。
 */

type DbClient = PrismaClient;

/* ============================== 视图类型 ============================== */

/** 列表项的有效分摘要（各维度有效分） */
export interface HistoryScoreSummary {
  dimension: string;
  effectiveScore: number;
}

/** 列表项：日期 / 案例名 / 训练重点 / 有效分摘要 / 状态 */
export interface HistoryListItem {
  sessionId: string;
  date: string; // ISO 日期（每日一题归属日）
  caseTitle: string;
  /** 训练重点：能力标签（2~4 个） */
  abilityTags: string[];
  isExtra: boolean;
  state: TrainingSessionState;
  scores: HistoryScoreSummary[];
}

/** 分页元数据（页码 / 每页 / 总数 / 总页数） */
export interface HistoryPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** GET /api/history 的 data 负载 */
export interface HistoryListView {
  items: HistoryListItem[];
  pagination: HistoryPagination;
}

/** 提示使用回放：层数 + 请求时间 */
export interface HistoryHintEventView {
  layer: number;
  requestedAt: string; // ISO 时间
}

/** 评分四元组（D8）+ 诊断文本 */
export interface HistoryScoreView {
  dimension: string;
  rawScore: number;
  hintCount: number;
  coefficient: number;
  effectiveScore: number;
  diagnosisText: string | null;
}

/** 详情可缺失的分区（任务契约：标记而非报错） */
export type HistoryMissingSection = "firstAnswer" | "finalAnswer" | "scores" | "feedback";

/** GET /api/history/:id 的 data 负载：完整回放视图 */
export interface HistoryDetailView {
  sessionId: string;
  date: string;
  isExtra: boolean;
  state: TrainingSessionState;
  // 案例区
  caseTitle: string;
  caseBackground: unknown;
  mainQuestion: string;
  abilityTags: string[];
  difficulty: number;
  // 两版答案（null = 未提交 / 缺失）
  firstAnswer: string | null;
  firstSubmittedAt: string | null;
  finalAnswer: string | null;
  finalSubmittedAt: string | null;
  // 提示使用
  hintCount: number;
  hintEvents: HistoryHintEventView[];
  // 追问对话记录（BR-4）
  followups: FollowupRecord[];
  // 评分四元组
  scores: HistoryScoreView[];
  // 反馈（BR-7：最需优化问题 + 下一步；null = 缺失）
  feedback: { topIssueText: string; nextFocusText: string } | null;
  /** 缺失分区标记（按流程应存在但落库缺失的分区） */
  missing: HistoryMissingSection[];
}

/* ============================== 装配输入行 ============================== */

export interface HistorySessionListRow {
  id: string;
  date: Date;
  isExtra: boolean;
  state: TrainingSessionState;
  question: { caseTitle: string; abilityTags: unknown };
  scores: { dimension: string; effectiveScore: number }[];
}

export interface HistorySessionDetailRow {
  id: string;
  userId: string;
  date: Date;
  isExtra: boolean;
  state: TrainingSessionState;
  firstAnswer: string | null;
  firstSubmittedAt: Date | null;
  finalAnswer: string | null;
  finalSubmittedAt: Date | null;
  hintCount: number;
  followups: unknown;
  question: {
    caseTitle: string;
    caseBackground: unknown;
    mainQuestion: string;
    abilityTags: unknown;
    difficulty: number;
  };
  hintEvents: { layer: number; requestedAt: Date }[];
  scores: {
    dimension: string;
    rawScore: number;
    hintCount: number;
    coefficient: number;
    effectiveScore: number;
    diagnosisText: string | null;
  }[];
  feedback: { topIssueText: string; nextFocusText: string } | null;
}

/* ============================== 纯函数装配 ============================== */

/** 能力标签 jsonb 防御解析：仅保留字符串项 */
export function parseAbilityTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

/** 分页元数据：totalPages 向上取整，0 条记录时为 0 */
export function buildPagination(
  total: number,
  page: number,
  pageSize: number,
): HistoryPagination {
  return {
    page,
    pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}

export function toHistoryListItem(row: HistorySessionListRow): HistoryListItem {
  return {
    sessionId: row.id,
    date: row.date.toISOString().slice(0, 10),
    caseTitle: row.question.caseTitle,
    abilityTags: parseAbilityTags(row.question.abilityTags),
    isExtra: row.isExtra,
    state: row.state,
    scores: row.scores.map((score) => ({
      dimension: score.dimension,
      effectiveScore: score.effectiveScore,
    })),
  };
}

/**
 * 缺失分区判定：仅标记"按流程应存在但落库缺失"的分区。
 * 进行中会话未提交答案/未评分属正常态，不标记；提示 0 层、无追问亦属正常态。
 */
export function computeMissingSections(
  row: Pick<
    HistorySessionDetailRow,
    "state" | "firstAnswer" | "finalAnswer" | "scores" | "feedback"
  >,
): HistoryMissingSection[] {
  const missing: HistoryMissingSection[] = [];
  const pastFirstSubmit = row.state === "followup" || row.state === "scored";
  if (pastFirstSubmit && row.firstAnswer === null) missing.push("firstAnswer");
  if (row.state === "scored") {
    if (row.finalAnswer === null) missing.push("finalAnswer");
    if (row.scores.length === 0) missing.push("scores");
    if (row.feedback === null) missing.push("feedback");
  }
  return missing;
}

/** 详情回放装配：案例 → 两版答案 → 提示 → 追问 → 评分 → 反馈（+ 缺失标记） */
export function toHistoryDetailView(row: HistorySessionDetailRow): HistoryDetailView {
  return {
    sessionId: row.id,
    date: row.date.toISOString().slice(0, 10),
    isExtra: row.isExtra,
    state: row.state,
    caseTitle: row.question.caseTitle,
    caseBackground: row.question.caseBackground,
    mainQuestion: row.question.mainQuestion,
    abilityTags: parseAbilityTags(row.question.abilityTags),
    difficulty: row.question.difficulty,
    firstAnswer: row.firstAnswer,
    firstSubmittedAt: row.firstSubmittedAt?.toISOString() ?? null,
    finalAnswer: row.finalAnswer,
    finalSubmittedAt: row.finalSubmittedAt?.toISOString() ?? null,
    hintCount: row.hintCount,
    hintEvents: row.hintEvents.map((event) => ({
      layer: event.layer,
      requestedAt: event.requestedAt.toISOString(),
    })),
    followups: parseFollowupRecords(row.followups),
    scores: row.scores.map((score) => ({
      dimension: score.dimension,
      rawScore: score.rawScore,
      hintCount: score.hintCount,
      coefficient: score.coefficient,
      effectiveScore: score.effectiveScore,
      diagnosisText: score.diagnosisText,
    })),
    feedback: row.feedback
      ? { topIssueText: row.feedback.topIssueText, nextFocusText: row.feedback.nextFocusText }
      : null,
    missing: computeMissingSections(row),
  };
}

/* ============================== 查询编排 ============================== */

/** 历史列表：当前用户记录按日期倒序分页，响应含分页元数据 */
export async function getHistoryList(
  db: DbClient,
  userId: string,
  page: number,
  pageSize: number,
): Promise<HistoryListView> {
  const [total, rows] = await Promise.all([
    countHistorySessions(db, userId),
    findHistorySessionPage(db, userId, page, pageSize),
  ]);
  return {
    items: rows.map(toHistoryListItem),
    pagination: buildPagination(total, page, pageSize),
  };
}

/** 详情回放：不存在或不属于当前用户一律 404（不泄露存在性） */
export async function getHistoryDetail(
  db: DbClient,
  sessionId: string,
  userId: string,
): Promise<HistoryDetailView> {
  const row = await findHistorySessionDetail(db, sessionId);
  if (!row || row.userId !== userId) {
    throw new HistoryError(CODES.SESSION_NOT_FOUND, 404, "训练记录不存在");
  }
  return toHistoryDetailView(row);
}
