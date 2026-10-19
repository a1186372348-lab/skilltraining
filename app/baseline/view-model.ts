/**
 * /baseline 页 view-model（T17a / D19；T36 / D38 题间并行评分）：展示判定全部下沉为纯函数，
 * 组件只负责渲染与调用适配层（与 app/training/session、app/_dashboard 同一模式）。
 *
 * 双计数口径：
 * - answeredCount（已提交终答题数）：驱动流程推进——第几题、是否进收尾页；
 * - doneCount（已评分题数）：仅收尾页揭晓进度（能力边界生成到第几项）。
 */

/** GET /api/training/baseline 的 data 负载（前端视角） */
export interface BaselineStatusView {
  required: boolean;
  total: number;
  /** 已提交终答的基线题数（流程推进口径） */
  answeredCount: number;
  /** 已评分完成的基线题数（收尾页揭晓进度口径） */
  doneCount: number;
  nextQuestion: { id: string; caseTitle: string } | null;
  completedAt: string | null;
}

/** 当前第几题（1 起；全部作答后封顶在 total） */
export function currentQuestionIndex(answeredCount: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(answeredCount + 1, total);
}

/** 进度指示文案：进行中「第 1/8 题」，全部作答「8/8 已完成」 */
export function progressText(answeredCount: number, total: number): string {
  if (total <= 0) return "";
  if (answeredCount >= total) return `${total}/${total} 已完成`;
  return `第 ${answeredCount + 1}/${total} 题`;
}

/** 侧栏状态文案（与今日训练页「今日状态」同一槽位） */
export function baselineStageText(answeredCount: number, total: number): string {
  if (total <= 0) return "基线";
  return `基线 ${Math.min(answeredCount + (answeredCount >= total ? 0 : 1), total)}/${total}`;
}

/**
 * 是否展示开场说明卡：仅「一题未做且当前题尚未作答」时展示；
 * 中断恢复（已有首答或已作答过题）直接进入训练，不重复打扰。
 */
export function shouldShowIntro(
  view: { firstAnswer: string | null } | null,
  answeredCount: number,
): boolean {
  return answeredCount === 0 && !view?.firstAnswer;
}

/** 题间过渡卡进度文案（T36 试测修订）：已完成 n/total 题；done 超出 total 时封顶 */
export function transitionProgressText(done: number, total: number): string {
  if (total <= 0) return "";
  return `已完成 ${Math.min(done, total)}/${total} 题`;
}

/** 题间过渡卡主按钮：最后一题为「完成测评，查看能力边界 →」，其余「进入下一题 →」 */
export function transitionContinueLabel(done: number, total: number): string {
  return total > 0 && done >= total ? "完成测评，查看能力边界 →" : "进入下一题 →";
}

/** 收尾页揭晓的 8 个能力一级维度（展示口径，与 Prd.md 1.3 / server profile ABILITY_DIMENSIONS 一致） */
export const REVEAL_DIMENSIONS = [
  "问题定义",
  "用户理解",
  "根因分析",
  "产品价值判断",
  "方案设计",
  "产品取舍",
  "指标与验证",
  "产品表达",
] as const;

/** 收尾页评分进度文案：「已完成 5/8 项能力分析」 */
export function finishingProgressText(doneCount: number, total: number): string {
  if (total <= 0) return "";
  return `已完成 ${Math.min(doneCount, total)}/${total} 项能力分析`;
}

/** 收尾页已点亮的维度数：按评分完成比例递进，封顶 8（题数与维度数不一致时按比例折算） */
export function litDimensionCount(doneCount: number, total: number): number {
  if (total <= 0) return 0;
  const ratio = Math.min(Math.max(doneCount, 0), total) / total;
  return Math.min(Math.round(ratio * REVEAL_DIMENSIONS.length), REVEAL_DIMENSIONS.length);
}

/** 收尾页超时提示阈值：进入收尾约 3 分钟仍未评完时管理预期（AI 网关高负载时段） */
export const FINISHING_DELAY_HINT_MS = 3 * 60 * 1000;

/** 是否展示「生成时间比预期长」提示（入参为进入收尾页至今的毫秒数） */
export function showDelayHint(elapsedMs: number): boolean {
  return elapsedMs >= FINISHING_DELAY_HINT_MS;
}
