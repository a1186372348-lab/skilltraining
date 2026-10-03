import type {
  AbilityDimensionView,
  AbilityPageView,
  AbilityStatusLabel,
  HintDependencyBand,
  Trend,
} from "./contract";

/**
 * 能力画像页视图模型（纯函数，T09）。
 * 把"画像数据 → 界面"的全部判定集中在这里，组件只负责渲染；
 * 无 DOM/React 依赖，可在 node 环境用 vitest 直接覆盖（同 app/today/view-model.ts 模式）。
 */

/** 整页降级（T09 失败与回滚）：8 维全部未观测时显示「开始第一次训练后生成」引导态 */
export function isGuideState(view: AbilityPageView): boolean {
  return view.insight.observedCount === 0;
}

/** 顶部洞察条文案：AI 已了解你 n/8 个维度 · 下一题优先方向 */
export function insightText(view: AbilityPageView): string {
  const { observedCount, totalCount, nextFocus } = view.insight;
  return `AI 已了解你 ${observedCount}/${totalCount} 个维度 · ${nextFocus.text}`;
}

/** 大号分数展示：整数去小数，最多一位小数；非法值显示占位符 */
export function formatProfileScore(score: number): string {
  if (!Number.isFinite(score)) return "-";
  const rounded = Math.round(score * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 观察次数小字 */
export function observationText(count: number): string {
  return `观察 ${count} 次`;
}

export interface SparklineGeometry {
  /** SVG polyline 点串（"x,y x,y …"） */
  points: string;
  /** 末端圆点坐标 */
  end: { x: number; y: number };
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, score));
}

/**
 * 趋势火花线几何：把有效分序列（0~100）映射到 SVG 坐标。
 * x 在 [padding, width-padding] 均匀铺开；y 分数越高越靠上。
 * 单点（首次观测）画水平短线；空序列返回 null（未观测维度不渲染）。
 */
export function sparklineGeometry(
  series: number[],
  width = 120,
  height = 32,
  padding = 8,
): SparklineGeometry | null {
  if (series.length === 0) return null;
  const toY = (score: number) => {
    const ratio = clampScore(score) / 100;
    const y = padding + (1 - ratio) * (height - padding * 2);
    return Math.round(y * 10) / 10;
  };
  const innerWidth = width - padding * 2;
  const step = innerWidth / (series.length - 1 || 1);
  const coords = series.map((score, index) => ({
    // 单点固定在右端（最新一次观测），由下方补点向左拉平
    x:
      series.length === 1
        ? width - padding
        : Math.round((padding + step * index) * 10) / 10,
    y: toY(score),
  }));
  // 单点：向左补一个同高点，画成水平短线（无变化可展示）
  const line = coords.length === 1 ? [{ x: padding, y: coords[0].y }, coords[0]] : coords;
  return {
    points: line.map((p) => `${p.x},${p.y}`).join(" "),
    end: coords[coords.length - 1],
  };
}

/** 火花线配色：上升趋势用主色强调，其余中性灰（原型 B 屏 2） */
export function sparklineStroke(trend: Trend | null): string {
  return trend === "上升" ? "#2563EB" : "#94A3B8";
}

/** 状态标签样式（原型 B 屏 2：稳定绿 / 样本较少灰 / 上升蓝 / 下降灰） */
export function statusTagClass(label: AbilityStatusLabel): string {
  switch (label) {
    case "稳定":
      return "border-[#D1FAE5] bg-[#ECFDF5] text-[#047857]";
    case "↑ 上升中":
      return "border-[#D9E7FD] bg-[#EFF5FF] text-[#1D4ED8]";
    case "样本较少":
    case "↓ 下降中":
      return "border-[#E6EAF1] bg-[#F1F5F9] text-[#64748B]";
  }
}

/** 最弱已观测维度（默认展开诊断）：当前分最低；同分取观察次数较少者；再同取维度序前者 */
export function weakestObservedDimension(
  dimensions: AbilityDimensionView[],
): AbilityDimensionView | null {
  const observed = dimensions.filter((d) => d.observed);
  if (observed.length === 0) return null;
  return [...observed].sort(
    (a, b) =>
      (a.currentScore ?? 0) - (b.currentScore ?? 0) ||
      a.observationCount - b.observationCount,
  )[0];
}

/**
 * 弱项「特征」行（BR-6 同分不同病：同样的分数，按提示依赖分档给出不同特征描述）。
 * 固定规则文案；hintDependency 为近 5 次平均提示次数（服务端口径）。
 */
export function featureLineOf(dim: AbilityDimensionView): string {
  switch (dim.hintDependencyBand) {
    case "高":
      return "作答过程频繁依赖提示（近几次平均 2.5 层以上），终答质量与独立程度不匹配";
    case "中":
      return "作答偶用提示，独立完成的稳定性有待观察";
    case "低":
      return "基本独立作答，当前分数反映真实水平";
    default:
      return "样本尚少，提示依赖特征待积累";
  }
}

/** 弱项「诊断」行：与特征同档差异化（BR-6） */
export function diagnosisLineOf(dim: AbilityDimensionView): string {
  switch (dim.hintDependencyBand) {
    case "高":
      return "独立构建分析框架的能力待加强，提示应是脚手架而非答案本身";
    case "中":
      return "已具备基本分析路径，下一步减少提示使用以巩固独立性";
    case "低":
      return "思考独立性良好，短板在分析深度，建议针对该维度持续强化";
    default:
      return "完成更多该维度训练后，将给出更具体的诊断";
  }
}

/**
 * 整体提示依赖度仪表点亮段数（5 段）：
 * 低 → 1 段（靠左）、中 → 3 段（居中）、高 → 5 段（靠右），未知不点亮。
 */
export function gaugeLevelOf(band: HintDependencyBand | null): number {
  switch (band) {
    case "低":
      return 1;
    case "中":
      return 3;
    case "高":
      return 5;
    default:
      return 0;
  }
}
