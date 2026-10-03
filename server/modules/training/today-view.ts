import type { Question, TrainingSession, TrainingSessionState } from "@prisma/client";

import { independenceCoefficient } from "./coefficient";

/**
 * 今日训练视图（GET /api/training/today 的数据载荷）。
 *
 * FR-10 出口防线：rubric、hintTree 原始字段、评分 prompt 一律不进入本视图；
 * 提示树只按 hintCount 释放已解锁层（BR-3：仅按当前状态返回当前层提示）。
 */

export interface ReleasedHint {
  level: number;
  stage: string;
  question: string;
}

export interface FollowupRecord {
  round: number;
  question: string;
}

export interface TodayView {
  sessionId: string;
  state: TrainingSessionState;
  date: string; // ISO 日期（每日一题归属日）
  // 题目展示（US-003）：案例 / 训练重点 / 主问题 / 资料
  caseTitle: string;
  caseBackground: unknown; // 案例背景五字段（T13 新结构 {text, citations[]}；旧版字符串形原样透传）
  caseSources: CaseSourceItem[]; // 案例来源（T13 / BR-8：上标引用标号对应的出处列表）
  abilityTags: unknown; // 训练重点：今天练什么（能力标签 2~4 个）
  difficulty: number;
  mainQuestion: string;
  materials: unknown; // { core: [核心 2], extended: [扩展 3] }（D9）
  // 作答进度
  hintCount: number;
  coefficient: number; // 当前独立完成系数（D12 透明化）
  releasedHints: ReleasedHint[]; // 已释放提示层（刷新恢复用）
  canRequestHint: boolean; // 首答后或 5 层用满即 false（D7）
  firstAnswer: string | null;
  finalAnswer: string | null;
  followups: FollowupRecord[]; // 追问对话记录（BR-4）
  firstSubmittedAt: string | null;
  finalSubmittedAt: string | null;
}

/** 案例来源条目（T13 / BR-8：五字段引用标号 [n] 对应的出处） */
export interface CaseSourceItem {
  id: number;
  title: string;
  publisher: string;
  url: string;
}

/** 解析 case_sources jsonb（导入管线已按 schema 校验，这里做防御性读取：非法项丢弃） */
function parseCaseSources(raw: unknown): CaseSourceItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is CaseSourceItem =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { id?: unknown }).id === "number" &&
        typeof (item as { title?: unknown }).title === "string" &&
        typeof (item as { publisher?: unknown }).publisher === "string" &&
        typeof (item as { url?: unknown }).url === "string",
    )
    .map((item) => ({ id: item.id, title: item.title, publisher: item.publisher, url: item.url }));
}

/**
 * 拆分 case_background jsonb：内嵌 case_sources 键 → 视图独立字段（不重复下发）；
 * 五字段区域原样透传——新结构 {text, citations[]} 与旧版字符串形字段（开发库已归档
 * 种子题的会话）都兼容，不报错；uncertainty 等既有内嵌键保持原样。
 */
function splitCaseBackground(raw: unknown): {
  caseBackground: unknown;
  caseSources: CaseSourceItem[];
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { caseBackground: raw, caseSources: [] };
  }
  const { case_sources: rawSources, ...rest } = raw as Record<string, unknown>;
  return { caseBackground: rest, caseSources: parseCaseSources(rawSources) };
}

/** 解析 hint_tree jsonb（导入管线已按 schema 校验，这里做防御性读取） */
function parseHintTree(raw: unknown): ReleasedHint[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is { level: number; stage: string; question: string } =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { level?: unknown }).level === "number" &&
        typeof (item as { question?: unknown }).question === "string",
    )
    .map((item) => ({ level: item.level, stage: String(item.stage ?? ""), question: item.question }))
    .sort((a, b) => a.level - b.level);
}

/** 解析 followups jsonb 为追问记录数组 */
export function parseFollowupRecords(raw: unknown): FollowupRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is FollowupRecord =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { round?: unknown }).round === "number" &&
        typeof (item as { question?: unknown }).question === "string",
    )
    .map((item) => ({ round: item.round, question: item.question }));
}

export function toTodayView(session: TrainingSession, question: Question): TodayView {
  const hintTree = parseHintTree(question.hintTree);
  const releasedHints = hintTree.slice(0, Math.max(0, session.hintCount));
  const { caseBackground, caseSources } = splitCaseBackground(question.caseBackground);
  return {
    sessionId: session.id,
    state: session.state,
    date: session.date.toISOString().slice(0, 10),
    caseTitle: question.caseTitle,
    caseBackground,
    caseSources,
    abilityTags: question.abilityTags,
    difficulty: question.difficulty,
    mainQuestion: question.mainQuestion,
    materials: question.materials,
    hintCount: session.hintCount,
    coefficient: independenceCoefficient(session.hintCount),
    releasedHints,
    // D7：首次提交后提示永久消失；5 层用满也不可再请求
    canRequestHint: session.firstSubmittedAt === null && session.hintCount < 5,
    firstAnswer: session.firstAnswer,
    finalAnswer: session.finalAnswer,
    followups: parseFollowupRecords(session.followups),
    firstSubmittedAt: session.firstSubmittedAt?.toISOString() ?? null,
    finalSubmittedAt: session.finalSubmittedAt?.toISOString() ?? null,
  };
}
