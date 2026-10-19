/**
 * 训练反馈页 API 契约（前端视角，T07）。
 *
 * 与 server/modules/feedback/view.ts、survey.ts 的响应形状对齐；
 * 统一响应封装沿用 server/lib/api-response.ts：{ success: true, data } / { success: false, error }。
 * 若联调时服务端字段有出入，只需修改本文件与 app/training/feedback/[id]/api.ts，页面组件不感知。
 */

/** 各维度得分四元组（D8：原始分/提示次数/系数/有效分） */
export interface FeedbackDimensionScore {
  dimension: string;
  /** 原始表现分（AI 按 Rubric 评） */
  rawScore: number;
  /** 首次提交前的提示次数 */
  hintCount: number;
  /** 独立完成系数（BR-2） */
  coefficient: number;
  /** 有效得分 = 原始分 × 系数（BR-1） */
  effectiveScore: number;
  diagnosisText: string | null;
}

/** 问卷状态（D16：needsPeriodicQ3 为 true 时前端渲染第三问） */
export interface SurveyStatus {
  submitted: boolean;
  needsPeriodicQ3: boolean;
}

/** 评分进行中：前端显示"总监评分中"等待态并轮询（真实延迟 35~49 秒） */
export interface ScoringFeedbackView {
  status: "scoring";
  sessionId: string;
}

/** 评分完成：反馈页全部内容的装配视图 */
export interface ReadyFeedbackView {
  status: "ready";
  sessionId: string;
  /** 题目类型（T36 / D38：基线题反馈页主按钮为「回到基线测评」，不出「再练一题」） */
  questionKind: "baseline" | "daily";
  scores: FeedbackDimensionScore[];
  /** 最需要优化的一个问题（BR-7） */
  topIssueText: string;
  /** 下一步训练方向 */
  nextFocusText: string;
  survey: SurveyStatus;
}

/** GET /api/training/:id/feedback 的 data 负载 */
export type FeedbackView = ScoringFeedbackView | ReadyFeedbackView;

/** POST /api/feedback-survey 的 data 负载 */
export interface SubmitSurveyResult {
  sessionId: string;
  q1Clarity: number;
  q2Next: number;
  periodicQ3: number | null;
  needsPeriodicQ3: boolean;
  /** false = 幂等命中既有记录（重复提交未覆盖） */
  created: boolean;
}
