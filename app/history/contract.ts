/**
 * 训练历史页 API 契约（前端视角，T10 / US-009 / FR-9）。
 *
 * 与 server/modules/history/view.ts 的响应形状对齐；
 * 统一响应封装沿用 server/lib/api-response.ts：{ success: true, data } / { success: false, error }。
 * 若联调时服务端字段有出入，只需修改本文件与 app/history/api.ts，页面组件不感知。
 */

/** 会话状态（与 prisma TrainingSessionState 枚举一致） */
export type HistorySessionState = "reading" | "answering" | "followup" | "scored";

/** 列表项的有效分摘要（各维度有效分） */
export interface HistoryScoreSummary {
  dimension: string;
  effectiveScore: number;
}

/** 列表项：日期 / 案例名 / 训练重点 / 有效分摘要 / 状态 */
export interface HistoryListItem {
  sessionId: string;
  /** ISO 日期（YYYY-MM-DD，每日一题归属日） */
  date: string;
  caseTitle: string;
  /** 训练重点：能力标签（2~4 个） */
  abilityTags: string[];
  /** 是否加练（D3） */
  isExtra: boolean;
  state: HistorySessionState;
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

/** 提示使用回放：层数 + 请求时间（ISO） */
export interface HistoryHintEventView {
  layer: number;
  requestedAt: string;
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

/** 追问对话记录（BR-4：AI 总监逐轮提问） */
export interface HistoryFollowupView {
  round: number;
  question: string;
}

/** 详情可缺失的分区（任务契约：标记而非报错） */
export type HistoryMissingSection = "firstAnswer" | "finalAnswer" | "scores" | "feedback";

/** GET /api/history/:id 的 data 负载：完整回放视图 */
export interface HistoryDetailView {
  sessionId: string;
  date: string;
  isExtra: boolean;
  state: HistorySessionState;
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
  // 追问对话记录
  followups: HistoryFollowupView[];
  // 评分四元组
  scores: HistoryScoreView[];
  // 反馈（BR-7：最需优化问题 + 下一步；null = 缺失）
  feedback: { topIssueText: string; nextFocusText: string } | null;
  /** 缺失分区标记 */
  missing: HistoryMissingSection[];
}
