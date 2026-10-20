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

/**
 * 追问闸门判定记录（T35 / D37，2026-10-19 起两分支落库）：followups jsonb 数组首元素
 * 恒为此标记（不是追问轮次），追问轮次跟在其后。无论判定追问还是跳过都落库——
 * 让「AI 是否真正逐条判定」可审计、可监测（scripts/gate-probe.ts 分布监测）；
 * reason 仅供服务端审计，绝不下发前端。
 */
export interface FollowupGateDecisionRecord {
  type: "gate_decision";
  /** 判定结论：true = 需要追问（轮次跟随其后）；false = 闸门跳过（直进终答） */
  shouldFollowup: boolean;
  /** 判定理由（中文一句话；AI 产出，仅落库审计） */
  reason: string;
  /** 判定时间（ISO 字符串） */
  decidedAt: string;
}

/** 构造闸门判定记录（落库首元素用） */
export function buildFollowupGateDecisionRecord(
  shouldFollowup: boolean,
  reason: string,
  decidedAt: Date = new Date(),
): FollowupGateDecisionRecord {
  return { type: "gate_decision", shouldFollowup, reason, decidedAt: decidedAt.toISOString() };
}

/**
 * 存量闸门跳过标记（T35 上线首日结构，2026-10-19 由 gate_decision 取代，仅读取侧兼容）：
 * 仅跳过分支落库，无 shouldFollowup 字段。
 */
export interface FollowupGateSkipRecord {
  type: "gate_skip";
  /** 判定理由（中文一句话；AI 产出，仅落库审计） */
  reason: string;
  /** 判定时间（ISO 字符串） */
  decidedAt: string;
}

function validReason(raw: unknown): raw is string {
  return typeof raw === "string" && raw.trim().length > 0;
}

/**
 * 从 followups jsonb 中定位闸门判定记录（防御性读取）：
 * 无标记 / 非数组 / shouldFollowup 非布尔 / reason 缺失（不可审计）一律返回 null；
 * 存量 gate_skip 不属于本类型（由 parseFollowupGateSkip 兼容口径覆盖）。
 */
export function parseFollowupGateDecision(raw: unknown): FollowupGateDecisionRecord | null {
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as {
      type?: unknown;
      shouldFollowup?: unknown;
      reason?: unknown;
      decidedAt?: unknown;
    };
    if (record.type !== "gate_decision") continue;
    if (typeof record.shouldFollowup !== "boolean" || !validReason(record.reason)) return null;
    return {
      type: "gate_decision",
      shouldFollowup: record.shouldFollowup,
      reason: record.reason,
      decidedAt: typeof record.decidedAt === "string" ? record.decidedAt : "",
    };
  }
  return null;
}

/**
 * 闸门跳过判定（视图/守卫统一口径）：gate_decision 且 shouldFollowup=false，
 * 或存量 gate_skip 标记（读取侧兼容）。命中即返回该标记记录，否则 null。
 */
export function parseFollowupGateSkip(
  raw: unknown,
): FollowupGateDecisionRecord | FollowupGateSkipRecord | null {
  const decision = parseFollowupGateDecision(raw);
  if (decision !== null) return decision.shouldFollowup ? null : decision;
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as { type?: unknown; reason?: unknown; decidedAt?: unknown };
    if (record.type !== "gate_skip") continue;
    if (!validReason(record.reason)) return null;
    return {
      type: "gate_skip",
      reason: record.reason,
      decidedAt: typeof record.decidedAt === "string" ? record.decidedAt : "",
    };
  }
  return null;
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
  /** 基线进度（仅 kind=baseline 时下发：{ done: 已作答（提交终答）题数（T36 / D38 口径）, total: 基线题总数 }） */
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
  /** 追问闸门跳过标记（T35 / D37）：闸门判定「无需追问」为 true（直进终答）；reason 仅落库审计不下发 */
  followupGateSkipped: boolean;
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
 * 存量无 hint / hintReleased 字段的老记录按「无提示、未释放」容错（不回填数据）；
 * T35 闸门跳过标记（gate_skip）不是追问轮次，结构性过滤（无 round/question 字段）。
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
    // T35 / D37：闸门跳过标记存在即 true（标记非追问轮次，parseFollowupRecords 已过滤）
    followupGateSkipped: parseFollowupGateSkip(session.followups) !== null,
    firstSubmittedAt: session.firstSubmittedAt?.toISOString() ?? null,
    finalSubmittedAt: session.finalSubmittedAt?.toISOString() ?? null,
  };
}
