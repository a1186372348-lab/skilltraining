import type { FeedbackDimensionScore } from "./contract";

/**
 * 训练反馈页视图模型（纯函数，T07）。
 * 把"反馈数据 → 界面"的全部判定集中在这里，组件只负责渲染；
 * 无 DOM/React 依赖，可在 node 环境用 vitest 直接覆盖（同 app/today/view-model.ts 模式）。
 */

/** 评分轮询间隔（真实评分延迟 35~49 秒，R5：3 秒一跳，进度感知与请求压力折中） */
export const SCORING_POLL_INTERVAL_MS = 3000;

/** 连续轮询失败达到该次数才展示错误态（瞬时网络抖动不打断等待） */
export const MAX_CONSECUTIVE_POLL_FAILURES = 5;

/** 大号有效分展示：整数去小数，最多一位小数；非法值显示占位符 */
export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return "-";
  const rounded = Math.round(score * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 系数展示：保留 1 位小数（规避 1−0.1×n 的浮点尾巴） */
export function coefficientText(coefficient: number): string {
  if (!Number.isFinite(coefficient)) return "1.0";
  return coefficient.toFixed(1);
}

/** 提示用量小字：0 次强调"完全独立"（BR-3 提示透明化正向反馈） */
export function hintUsageText(hintCount: number): string {
  if (!Number.isFinite(hintCount) || hintCount <= 0) return "完全独立作答";
  return `用了 ${hintCount} 次提示`;
}

/**
 * 有效得分行小字（BR-1/BR-2 可解释性）：
 * 原始 85 × 系数 0.8（用了 2 次提示）
 */
export function scoreBreakdownText(score: FeedbackDimensionScore): string {
  return `原始 ${formatScore(score.rawScore)} × 系数 ${coefficientText(score.coefficient)}（${hintUsageText(score.hintCount)}）`;
}

/** 「查看计算过程」展开内容：等式 + 系数规则（BR-2 对照说明） */
export function calculationDetailLines(score: FeedbackDimensionScore): string[] {
  return [
    "有效得分 = 原始表现分 × 独立完成系数",
    `${formatScore(score.rawScore)} × ${coefficientText(score.coefficient)} = ${formatScore(score.effectiveScore)}`,
    `系数规则：首次提交前${hintUsageText(score.hintCount)}，系数 ${coefficientText(score.coefficient)}（0 次 = 1.0，每多用 1 次 −0.1，最低 0.6）`,
  ];
}

/** 星级问卷题目 key（与 feedback_surveys 列一一对应） */
export type SurveyQuestionKey = "q1Clarity" | "q2Next" | "periodicQ3";

export interface SurveyQuestion {
  key: SurveyQuestionKey;
  text: string;
  /** 周期性一问（D16：每 5 次已评分训练才渲染） */
  periodic: boolean;
}

/** 问卷题目（FR-7 两问 + D16 周期性一问，对应成功指标"训练方向有效性感知"） */
export const SURVEY_QUESTIONS: readonly SurveyQuestion[] = [
  { key: "q1Clarity", text: "这次反馈说清了你的问题所在吗？", periodic: false },
  { key: "q2Next", text: "你知道下一步该练什么、为什么吗？", periodic: false },
  { key: "periodicQ3", text: "最近的训练是否越来越针对你自己？", periodic: true },
];

/** 本次应渲染的问题：固定两问 + 触发时追加周期性一问 */
export function visibleSurveyQuestions(needsPeriodicQ3: boolean): SurveyQuestion[] {
  return SURVEY_QUESTIONS.filter((question) => !question.periodic || needsPeriodicQ3);
}

/** 各题当前得分（null = 未点亮） */
export type SurveyAnswers = Record<SurveyQuestionKey, number | null>;

/** 星级取值校验：仅 1~5 整数 */
export function isStarValue(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

/** 可提交判定：所有已渲染问题都点亮（第三问触发时同样必答） */
export function canSubmitSurvey(answers: SurveyAnswers, needsPeriodicQ3: boolean): boolean {
  return visibleSurveyQuestions(needsPeriodicQ3).every((question) =>
    isStarValue(answers[question.key]),
  );
}

/** 轮询失败降级：连续失败超阈值才展示错误态（瞬时抖动不打断"评分中"等待） */
export function shouldShowPollError(consecutiveFailures: number): boolean {
  return consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES;
}

/** 侧边栏"今日状态"文案 */
export function feedbackStageText(view: { status: "scoring" | "ready" }): string {
  return view.status === "ready" ? "已完成" : "评分中";
}
