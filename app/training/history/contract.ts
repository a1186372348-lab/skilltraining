/**
 * 训练历史回放 API 契约（前端视角，T10 / US-009 / FR-9；T25 / D27 迁入产品训练模块）。
 *
 * 与 server/modules/history/view.ts 的响应形状对齐；
 * 统一响应封装沿用 server/lib/api-response.ts：{ success: true, data } / { success: false, error }。
 * 若联调时服务端字段有出入，只需修改本文件与 app/training/history/api.ts，页面组件不感知。
 *（列表契约已随旧 /history 列表页删除——大厅历史列表契约见 app/training/contract.ts）
 */

/** 会话状态（与 prisma TrainingSessionState 枚举一致） */
export type HistorySessionState = "reading" | "answering" | "followup" | "scored";

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
