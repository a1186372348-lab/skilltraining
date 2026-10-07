/**
 * /baseline 页 view-model（T17a / D19）：展示判定全部下沉为纯函数，
 * 组件只负责渲染与调用适配层（与 app/training/session、app/_dashboard 同一模式）。
 */

/** GET /api/training/baseline 的 data 负载（前端视角） */
export interface BaselineStatusView {
  required: boolean;
  total: number;
  doneCount: number;
  nextQuestion: { id: string; caseTitle: string } | null;
  completedAt: string | null;
}

/** 当前第几题（1 起；全部完成后封顶在 total） */
export function currentQuestionIndex(doneCount: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(doneCount + 1, total);
}

/** 进度指示文案：进行中「第 1/2 题」，全部完成「2/2 已完成」 */
export function progressText(doneCount: number, total: number): string {
  if (total <= 0) return "";
  if (doneCount >= total) return `${total}/${total} 已完成`;
  return `第 ${doneCount + 1}/${total} 题`;
}

/** 侧栏状态文案（与今日训练页「今日状态」同一槽位） */
export function baselineStageText(doneCount: number, total: number): string {
  if (total <= 0) return "基线";
  return `基线 ${Math.min(doneCount + (doneCount >= total ? 0 : 1), total)}/${total}`;
}

/**
 * 是否展示开场说明卡：仅「一题未做且当前题尚未作答」时展示；
 * 中断恢复（已有首答或已完成过题）直接进入训练，不重复打扰。
 */
export function shouldShowIntro(
  view: { firstAnswer: string | null } | null,
  doneCount: number,
): boolean {
  return doneCount === 0 && !view?.firstAnswer;
}
