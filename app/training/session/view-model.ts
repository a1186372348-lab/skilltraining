import type { FollowupRound, Material, TrainingSessionState } from "./contract";

/**
 * 今日训练页视图模型（纯函数，T05-Page）。
 * 把"会话状态 → 界面"的全部判定集中在这里，组件只负责渲染；
 * 无 DOM/React 依赖，可在 node 环境用 vitest 直接覆盖。
 */

/** 提示总层数（D5：每题固定 5 层渐进提示） */
export const MAX_HINT_LAYERS = 5;

/** 自由回答区的非强制思考方向小字（PRD 1.2 核心闭环） */
export const THINKING_DIRECTIONS = [
  "用户任务",
  "当前问题",
  "新价值",
  "成本",
  "风险",
] as const;

/** 页面阶段：reading 与 answering 都落在作答阶段（无独立"开始"接口，进入即可作答） */
export type FlowStage = "answering" | "followup" | "done";

/**
 * 独立完成系数（BR-2 修订 / D22）：max(0.6, 1 − 0.1 × 首答前提示次数 − 0.05 × 追问提示次数)。
 * 仅作服务端系数缺失时的兜底；非法输入按 0 次处理（系数 1.0）。
 * 与服务端 independenceCoefficient 同用整数运算（20 分制），避免浮点误差。
 */
export function coefficientForHintCount(hintCount: number, followupHintCount = 0): number {
  const n = Number.isFinite(hintCount) ? Math.max(0, Math.floor(hintCount)) : 0;
  const m = Number.isFinite(followupHintCount) ? Math.max(0, Math.floor(followupHintCount)) : 0;
  return Math.max(12, 20 - 2 * Math.min(n, 10) - m) / 20;
}

/** 系数展示格式：×1.0 / ×0.9 …（保留 1 位小数，规避 1−0.1×n 的浮点尾巴） */
export function formatCoefficient(coefficient: number): string {
  if (!Number.isFinite(coefficient)) return "×1.0";
  return `×${coefficient.toFixed(1)}`;
}

/**
 * 提示按钮下方小字（D12：请求提示时明示当前系数）。
 * coefficient 传服务端权威值；0 次时额外强调"完全独立"。
 */
export function hintMicrocopy(coefficient: number, hintCount: number): string {
  const current = formatCoefficient(coefficient);
  return hintCount === 0 ? `当前 ${current} · 完全独立` : `当前 ${current}`;
}

/**
 * 会话状态 → 页面阶段（刷新恢复的唯一判定入口）。
 * 注意：T05 阶段终答提交后状态仍停在 followup（scored 由 T06 评分后写入），
 * 因此"完成"以 state === scored 或 finalAnswer 已有实质内容判定。
 */
export function stageOfSession(
  state: TrainingSessionState,
  finalAnswer: string | null,
): FlowStage {
  if (state === "scored" || (finalAnswer !== null && canSubmitAnswer(finalAnswer))) {
    return "done";
  }
  // 此时 state 已收窄为 reading/answering/followup（scored 在上方提前返回）
  switch (state) {
    case "reading":
    case "answering":
      return "answering";
    case "followup":
      return "followup";
  }
}

/** 阶段标签（页头状态徽标） */
export function stageLabel(stage: FlowStage): string {
  switch (stage) {
    case "answering":
      return "作答中";
    case "followup":
      return "追问中";
    case "done":
      return "已完成";
  }
}

/**
 * 「给我一个提示」按钮显隐（D7 + BR-3）：
 * 仅作答阶段可见，首次提交后本题内永久消失（阶段门禁不受服务端标记影响）；
 * 作答阶段内优先采用服务端 canRequestHint 权威值，缺失时按 5 层上限本地判定。
 */
export function isHintButtonVisible(
  stage: FlowStage,
  hintCount: number,
  canRequestHint?: boolean,
): boolean {
  if (stage !== "answering") return false;
  if (typeof canRequestHint === "boolean") return canRequestHint;
  return hintCount < MAX_HINT_LAYERS;
}

/** 答案可提交校验：去空白后非空 */
export function canSubmitAnswer(text: string): boolean {
  return text.trim().length > 0;
}

/** 追问区对话气泡 */
export interface ChatMessage {
  /** director = AI 产品总监（左气泡）；user = 用户（右气泡） */
  role: "director" | "user";
  content: string;
  /** 是否为追问消息（用于气泡上的「追问」小标记） */
  isFollowup: boolean;
}

/** 追问为空时「生成中」判定窗口：首答提交后 120 秒（T22 / D25） */
export const FOLLOWUP_GENERATING_WINDOW_MS = 120_000;

/**
 * 追问为空时的状态判定（T22 / D25）：首答提交后 120 秒窗口内视为生成中，超窗视为失败；
 * firstSubmittedAt 为 null 或非法日期字符串按失败（数据异常兜底）。
 */
export function followupEmptyState(
  firstSubmittedAt: string | null,
  now: number,
): "generating" | "failed" {
  if (firstSubmittedAt === null) return "failed";
  const submittedAt = Date.parse(firstSubmittedAt);
  if (Number.isNaN(submittedAt)) return "failed";
  return now - submittedAt < FOLLOWUP_GENERATING_WINDOW_MS ? "generating" : "failed";
}

/**
 * 追问失败态渲染模式（T37 / D39）：
 * - none：正常（有总监追问消息，或追问为空但仍在生成中）——显示作答输入区；
 * - failed：确定失败且用户未跳过——隐藏作答输入区（没有追问可回应），
 *   渲染「重试本次对话」+「跳过追问，直接作答」出口；
 * - skipped：失败后用户选择跳过——恢复作答输入区，引导直接作答终案。
 */
export type FollowupFailureMode = "none" | "failed" | "skipped";

export function followupFailureMode(
  hasDirectorMessage: boolean,
  emptyState: "generating" | "failed" | null,
  skipped: boolean,
): FollowupFailureMode {
  if (hasDirectorMessage || emptyState !== "failed") return "none";
  return skipped ? "skipped" : "failed";
}

/** 追问阶段作答输入区显隐：仅失败未跳过态隐藏（没有追问可回应） */
export function isFollowupInputVisible(mode: FollowupFailureMode): boolean {
  return mode !== "failed";
}

/** 追问阶段输入框占位文案：跳过态引导直接作答终案 */
export function followupInputPlaceholder(mode: FollowupFailureMode): string {
  return mode === "skipped"
    ? "已跳过追问——直接写下你的最终结论与论证……"
    : "回应追问，修正或深化你的结论……";
}

/**
 * 组装追问区气泡序列：用户首答（右）→ 总监每轮追问（左，1~2 轮）。
 * 首答缺失或为空白时视为未提交，不产生气泡；
 * followups 为空（追问生成中或失败，T22 起由 followupEmptyState 区分）时只保留首答气泡。
 */
export function buildFollowupMessages(
  firstAnswer: string | null,
  followups: FollowupRound[],
): ChatMessage[] {
  if (!firstAnswer || !canSubmitAnswer(firstAnswer)) return [];
  const messages: ChatMessage[] = [
    { role: "user", content: firstAnswer, isFollowup: false },
  ];
  for (const round of followups) {
    messages.push({ role: "director", content: round.question, isFollowup: true });
  }
  return messages;
}

/** 资料视图条目：在契约数据上附加分组徽标 */
export interface MaterialView extends Material {
  kind: "core" | "extended";
  badge: "★核心" | "○扩展";
}

/** 参考资料列表视图：核心 2 篇在前（★核心），扩展 3 篇在后（○扩展） */
export function toMaterialViews(materials: {
  core: Material[];
  extended: Material[];
}): MaterialView[] {
  return [
    ...materials.core.map((item) => ({ ...item, kind: "core" as const, badge: "★核心" as const })),
    ...materials.extended.map((item) => ({
      ...item,
      kind: "extended" as const,
      badge: "○扩展" as const,
    })),
  ];
}

/* ============================== 案例事实引用（T13 / BR-8） ============================== */

/** 案例来源条目：字段引用编号对应的出处（解析为内联链接前的中间形态） */
export interface CaseSourceView {
  id: number;
  title: string;
  publisher: string;
  url: string;
}

/** 字段结尾内联引用链接视图：单引用「原文」，多引用按声明顺序「原文1」「原文2」… */
export interface CaseCitationLink {
  label: string;
  url: string;
  /** 悬停提示：来源标题 · 发布方 */
  title: string;
}

/** 案例背景五字段键（与内容 schema 的 T13 新契约一致） */
export type CaseFieldKey = "product" | "audience" | "scenario" | "features" | "status";

/** 案例背景单字段展示模型：文本 + 结尾内联引用链接（旧版字符串字段 citations 为空） */
export interface CaseFieldView {
  key: CaseFieldKey;
  label: string;
  text: string;
  citations: CaseCitationLink[];
}

/** 五字段展示顺序与默认标签；legacyKey 为旧版字符串结构（归档种子题会话）的兼容键 */
const CASE_FIELDS: readonly { key: CaseFieldKey; label: string; legacyKey?: string }[] = [
  { key: "product", label: "产品" },
  { key: "audience", label: "服务谁" },
  { key: "scenario", label: "场景" },
  { key: "features", label: "相关功能", legacyKey: "related_features" },
  { key: "status", label: "当前状态", legacyKey: "current_status" },
];

/** 防御解析 case_sources 数组：非数组返回空，缺字段/非对象条目丢弃（编号与链接缺一不可） */
export function toCaseSourceViews(raw: unknown): CaseSourceView[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is CaseSourceView =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { id?: unknown }).id === "number" &&
        typeof (item as { title?: unknown }).title === "string" &&
        typeof (item as { publisher?: unknown }).publisher === "string" &&
        typeof (item as { url?: unknown }).url === "string",
    )
    .map((item) => ({ id: item.id, title: item.title, publisher: item.publisher, url: item.url }));
}

/** 单字段值 → 文本 + 引用编号；新结构 {text, citations} 与旧版字符串形都兼容，非法值返回 null */
function parseCaseFieldValue(raw: unknown): { text: string; citationIds: number[] } | null {
  if (typeof raw === "string") {
    // 旧版字符串形字段（归档会话）：原样保留，无引用标记
    return raw.trim() ? { text: raw, citationIds: [] } : null;
  }
  if (typeof raw === "object" && raw !== null) {
    const record = raw as { text?: unknown; citations?: unknown };
    if (typeof record.text !== "string" || !record.text.trim()) return null;
    const citationIds = Array.isArray(record.citations)
      ? record.citations.filter(
          (id): id is number => typeof id === "number" && Number.isInteger(id) && id >= 1,
        )
      : [];
    return { text: record.text, citationIds };
  }
  return null;
}

/**
 * 案例背景 jsonb → 五字段展示模型：
 * - 新结构 {text, citations[]}：citations 按声明顺序解析为结尾内联链接视图，
 *   单引用显示「原文」，多引用按顺序编号「原文1」「原文2」…；
 *   在 sources 中不存在的标号丢弃（防御脏数据）；
 * - 旧版字符串字段（新键缺失时回退 legacyKey）：文本原样保留、citations 为空；
 * - 非对象输入返回空，非法字段值跳过。
 * labels 可覆盖默认标签（历史详情页复用同一解析、保留各自文案）。
 */
export function toCaseFieldViews(
  raw: unknown,
  sources: CaseSourceView[],
  labels: Partial<Record<CaseFieldKey, string>> = {},
): CaseFieldView[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const record = raw as Record<string, unknown>;
  const byId = new Map(sources.map((source) => [source.id, source]));
  const views: CaseFieldView[] = [];
  for (const field of CASE_FIELDS) {
    const value = record[field.key] ?? (field.legacyKey ? record[field.legacyKey] : undefined);
    const parsed = parseCaseFieldValue(value);
    if (!parsed) continue;
    const resolved = parsed.citationIds
      .map((id) => byId.get(id))
      .filter((source): source is CaseSourceView => source !== undefined);
    views.push({
      key: field.key,
      label: labels[field.key] ?? field.label,
      text: parsed.text,
      citations: resolved.map((source, index) => ({
        label: resolved.length === 1 ? "原文" : `原文${index + 1}`,
        url: source.url,
        title: `${source.title} · ${source.publisher}`,
      })),
    });
  }
  return views;
}
