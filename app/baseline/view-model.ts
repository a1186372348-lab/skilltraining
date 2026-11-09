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
  /** 逐题进度（T27 切片 3；可选——旧响应/缓存可能缺失，view-model 均有降级处理） */
  items?: BaselineProgressItemView[];
  /** 断点续测信息（T27 切片 3；可选，缺失时不显示横幅） */
  resume?: BaselineResumeView;
  /** 完成后八维点亮预览（T27 切片 3；进行中/旧响应为 null 或缺省） */
  dimensionPreview?: DimensionPreviewView[] | null;
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

/* ============================== T27 切片 4：逐题进度视图模型 ============================== */

/** GET /api/training/baseline 的逐题进度项（T27 切片 3 契约；可选——旧响应/缓存可能缺失，渲染侧防御） */
export interface BaselineProgressItemView {
  questionId: string;
  dimension: string | null;
  orderIndex: number;
  state: "pending" | "active" | "scored";
  /** 加深题标记（琥珀色呈现；confidence 触发追加，未触发不出现在 items） */
  isDeepen: boolean;
}

/** 断点续测信息（T27 切片 3 契约） */
export interface BaselineResumeView {
  hasInProgress: boolean;
  questionId: string | null;
  dimension: string | null;
  /** 评分/加深判定进行中（异步评分 30~60 秒；横幅据此切换「评分/判定进行中」文案） */
  scoringPending: boolean;
}

/** 完成后八维点亮预览项（BR-6：effectiveScore 为 null = 未知，不落 0 分） */
export interface DimensionPreviewView {
  dimension: string;
  effectiveScore: number | null;
}

/** 进度点渲染单元：位次（1 起）、三态、加深琥珀标记 */
export interface ProgressDot {
  key: string;
  /** 位次（1 起） */
  label: number;
  state: "pending" | "active" | "scored";
  /** 加深题（琥珀色） */
  isDeepen: boolean;
}

/**
 * 逐维进度点渲染模型：格数 = total（8 + 已触发加深，D30 上限 12）。
 * items 缺失时（旧响应/缓存）降级为按 total 的 pending 占位格——不崩、格数正确（防御性渲染）。
 */
export function toProgressDots(status: {
  total: number;
  items?: BaselineProgressItemView[];
}): ProgressDot[] {
  const total = Math.max(0, status.total);
  if (Array.isArray(status.items) && status.items.length > 0) {
    return status.items.map((item, index) => ({
      key: item.questionId,
      label: index + 1,
      state: item.state,
      isDeepen: item.isDeepen === true,
    }));
  }
  return Array.from({ length: total }, (_, index) => ({
    key: `placeholder-${index}`,
    label: index + 1,
    state: "pending" as const,
    isDeepen: false,
  }));
}

/** 断点续测横幅模型：null = 不显示；continue=继续作答；scoring=评分/判定进行中 */
export interface ResumeBannerView {
  kind: "continue" | "scoring";
  title: string;
  body: string;
}

/**
 * 断点续测横幅：resume.hasInProgress=true 时显示；
 * scoringPending=true（已提交题目在评审、加深判定同步进行）切换为「评分/判定进行中」文案，
 * 否则为「继续作答」文案（切片 3 遗留说明的两态区分）。
 */
export function resumeBanner(resume: BaselineResumeView | null | undefined): ResumeBannerView | null {
  if (!resume || resume.hasInProgress !== true) return null;
  if (resume.scoringPending) {
    return {
      kind: "scoring",
      title: "评分与判定进行中",
      body: "已提交的题目正在评审，部分维度可能还会追加加深题——进度会自动更新，你可以留在本页稍候。",
    };
  }
  return {
    kind: "continue",
    title: "继续基线测评",
    body: "上次进度已自动保存，直接从当前题继续作答即可。",
  };
}

/** 加深提示文案（产品语气：总监陪练的温度；同样计入测评、完成后统一揭晓） */
export const DEEPEN_HINT_TEXT =
  "这一维度总监想再看一题——同样计入测评，完成后一起揭晓你的能力边界";

/** 当前待作答题是否为已触发的加深题（items 缺失防御为 false；已评分题不算） */
export function isDeepenCurrent(
  items: BaselineProgressItemView[] | null | undefined,
  currentQuestionId: string | null,
): boolean {
  if (!currentQuestionId || !Array.isArray(items)) return false;
  const current = items.find((item) => item.questionId === currentQuestionId);
  return current?.isDeepen === true && current.state === "active";
}

/** 完成页八维点亮单元：lit=点亮（有分）；pending=生成中/未知；scoreText 仅点亮时给出 */
export interface RevealDimensionView {
  dimension: string;
  state: "lit" | "pending";
  /** 有效分展示文本（保留 1 位小数；未知/未点亮为 null） */
  scoreText: string | null;
}

/**
 * 完成页八维点亮预览模型：
 * - dimensionPreview 存在（已完成）→ 按有效分点亮；null 分为未知态（不点亮、无分数字符，BR-6）；
 * - dimensionPreview 为 null（评分中）→ 回退按 litCount 递进点亮（既有收尾页行为，不展示分数）。
 */
/** 有效分展示：整数原样、非整数保留 1 位小数（与评分校准展示口径一致） */
function formatEffectiveScore(score: number | null): string | null {
  if (score === null) return null;
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

export function toRevealPreview(
  preview: DimensionPreviewView[] | null | undefined,
  litCount: number,
): RevealDimensionView[] {
  if (Array.isArray(preview) && preview.length > 0) {
    return preview.map((item) => ({
      dimension: item.dimension,
      state: item.effectiveScore !== null ? "lit" : "pending",
      scoreText: formatEffectiveScore(item.effectiveScore),
    }));
  }
  return REVEAL_DIMENSIONS.map((dimension, index) => ({
    dimension,
    state: index < litCount ? "lit" : "pending",
    scoreText: null,
  }));
}
