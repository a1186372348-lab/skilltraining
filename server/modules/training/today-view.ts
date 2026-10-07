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

/** followups jsonb 落库记录（T19 / D22：含预生成提示与释放标记；存量无 hint 老记录读取侧容错） */
export interface FollowupRecord {
  round: number;
  question: string;
  /** 预生成提示（FR-10：仅释放后才可下发前端）；空串表示该轮无可用提示 */
  hint: string;
  /** 该轮提示是否已释放 */
  hintReleased: boolean;
}

/** 下发前端的单轮追问视图：未释放的提示绝不下发明文（hint 恒为 null） */
export interface FollowupView {
  round: number;
  question: string;
  /** 该轮是否有可请求的预生成提示（前端据此决定入口显隐） */
  hasHint: boolean;
  hintReleased: boolean;
  /** 已释放的提示文案；未释放恒为 null */
  hint: string | null;
}

export interface TodayView {
  sessionId: string;
  state: TrainingSessionState;
  date: string; // ISO 日期（每日一题归属日）
  /** 会话用途（T17a / D19）：基线未完成时 today 接口返回基线会话（kind=baseline） */
  kind: "baseline" | "daily";
  /** 基线进度（仅 kind=baseline 时下发：{ done: 已评完题数, total: 基线题总数 }） */
  baselineProgress: { done: number; total: number } | null;
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
  /** 追问阶段已释放提示次数（T19 / D22，服务端记录为准） */
  followupHintCount: number;
  coefficient: number; // 当前独立完成系数（D12 透明化；BR-2 修订：含追问提示半价项）
  releasedHints: ReleasedHint[]; // 已释放提示层（刷新恢复用）
  canRequestHint: boolean; // 首答后或 5 层用满即 false（D7）
  firstAnswer: string | null;
  finalAnswer: string | null;
  followups: FollowupView[]; // 追问对话记录（BR-4；未释放提示不下发明文，D22/FR-10）
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

/**
 * 解析 followups jsonb 为落库记录数组（防御性读取）：
 * 存量无 hint / hintReleased 字段的老记录按「无提示、未释放」容错（不回填数据）。
 */
export function parseFollowupRecords(raw: unknown): FollowupRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is { round: number; question: string; hint?: unknown; hintReleased?: unknown } =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { round?: unknown }).round === "number" &&
        typeof (item as { question?: unknown }).question === "string",
    )
    .map((item) => ({
      round: item.round,
      question: item.question,
      hint: typeof item.hint === "string" ? item.hint : "",
      hintReleased: item.hintReleased === true,
    }));
}

/** 落库记录 → 下发视图：FR-10 出口防线，未释放的提示绝不下发明文 */
export function toFollowupViews(records: FollowupRecord[]): FollowupView[] {
  return records.map((record) => ({
    round: record.round,
    question: record.question,
    hasHint: record.hint.trim().length > 0,
    hintReleased: record.hintReleased,
    hint: record.hintReleased ? record.hint : null,
  }));
}

/** toTodayView 的可选附加信息（T17a：基线会话标注与进度） */
export interface TodayViewExtras {
  kind?: "baseline" | "daily";
  baselineProgress?: { done: number; total: number } | null;
}

export function toTodayView(
  session: TrainingSession,
  question: Question,
  extras: TodayViewExtras = {},
): TodayView {
  const hintTree = parseHintTree(question.hintTree);
  const releasedHints = hintTree.slice(0, Math.max(0, session.hintCount));
  const { caseBackground, caseSources } = splitCaseBackground(question.caseBackground);
  return {
    sessionId: session.id,
    state: session.state,
    date: session.date.toISOString().slice(0, 10),
    kind: extras.kind ?? "daily",
    baselineProgress: extras.baselineProgress ?? null,
    caseTitle: question.caseTitle,
    caseBackground,
    caseSources,
    abilityTags: question.abilityTags,
    difficulty: question.difficulty,
    mainQuestion: question.mainQuestion,
    materials: question.materials,
    hintCount: session.hintCount,
    followupHintCount: session.followupHintCount ?? 0,
    // BR-2 修订（D22）：追问提示每次 −0.05，与首答前提示共用 0.6 下限
    coefficient: independenceCoefficient(session.hintCount, session.followupHintCount ?? 0),
    releasedHints,
    // D7：首次提交后提示永久消失；5 层用满也不可再请求
    canRequestHint: session.firstSubmittedAt === null && session.hintCount < 5,
    firstAnswer: session.firstAnswer,
    finalAnswer: session.finalAnswer,
    followups: toFollowupViews(parseFollowupRecords(session.followups)),
    firstSubmittedAt: session.firstSubmittedAt?.toISOString() ?? null,
    finalSubmittedAt: session.finalSubmittedAt?.toISOString() ?? null,
  };
}
