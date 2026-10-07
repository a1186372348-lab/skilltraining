/**
 * 产品训练大厅 API 契约（前端视角，T25 / D27）。
 *
 * 与 server/modules/training/hub-view.ts 的响应形状对齐；
 * 统一响应封装沿用 server/lib/api-response.ts：{ success: true, data } / { success: false, error }。
 * 若联调时服务端字段有出入，只需修改本文件与 app/training/api.ts 的解析，页面组件不感知。
 */

/** 会话状态（与 prisma TrainingSessionState 枚举一致） */
export type HubSessionState = "reading" | "answering" | "followup" | "scored";

/** 进行中会话的阶段（D27 状态机：reading/answering→作答中；followup 未交终答→追问中；已交终答未评分→评分中） */
export type HubSessionStage = "answering" | "followup" | "scoring";

/** 维度有效分摘要条目（当前卡得分条与历史行摘要共用，≤3 条） */
export interface HubScoreSummary {
  dimension: string;
  effectiveScore: number;
}

/** 当前训练卡三态（D27②） */
export type HubCurrentCard =
  | { kind: "in_progress"; sessionId: string; caseTitle: string; stage: HubSessionStage }
  | { kind: "not_started"; dateKey: string }
  | { kind: "completed"; sessionId: string; caseTitle: string; scores: HubScoreSummary[] };

/** 「进行中」态卡片（从联合中收窄；view-model 与页面组件共用） */
export type HubInProgressCard = Extract<HubCurrentCard, { kind: "in_progress" }>;

/** 训练历史列表行（D27④：加练并入列表，以「加练」徽章区分；基线会话不下发） */
export interface HubHistoryItem {
  sessionId: string;
  caseTitle: string;
  /** 是否加练（true→「加练」徽章，false→「每日」徽章） */
  isExtra: boolean;
  state: HubSessionState;
  /** 已提交终答（区分「追问中 / 评分中」徽章的依据） */
  hasFinalAnswer: boolean;
  abilityTags: string[];
  /** 维度有效分摘要（仅已完成会话非空，≤3 条） */
  scores: HubScoreSummary[];
  /** 进入训练时间（ISO；本地时区格式化「今天 HH:mm / M月D日」） */
  startedAt: string;
}

/** GET /api/training/hub 的 data 负载 */
export interface TrainingHubView {
  current: HubCurrentCard;
  history: HubHistoryItem[];
  /** 连续训练天数（侧栏底部展示，与首页统计条同口径） */
  streakDays: number;
}
