import type { AbilityDimensionView } from "./contract";

/**
 * 能力画像 3D 网络图映射（纯函数，T16 / D20；T18 / D21 色彩语义分档 + 固定大小重设计）。
 * 把「维度画像 → 力导向图节点/连线」的全部规则集中在这里，组件只负责渲染：
 * - 节点 = 8 维度：分数归一化决定大小；颜色按分档表语义——低分（<60）暖色警示
 *   （橙→琥珀）、中分（60~80）淡蓝→实蓝过渡、高分（≥80）实蓝，未观测半透明灰态；
 * - 布局 = 固定环形（T18 交付项 5）：节点按 index·(2π/total) 均匀分布在 xy 平面
 *   半径 NETWORK_RING_RADIUS 的圆环上，z 轴按索引确定性交错制造纵深；
 *   产出 fx/fy/fz 钉住坐标，不依赖力导向模拟的随机结果；
 * - 连线 = 全连接（8 维 → 28 边），锥形渐变粗细（T18 交付项 6，取代 D20「短板定粗」）：
 *   两端半径各由该端节点分数线性映射（高分端粗、低分端细）；
 *   任一端未观测则该边两端取最小半径并虚态（faint，3D 库无虚线原语，
 *   以最小半径 + 淡灰半透明表达）。
 * 无 DOM/React/three 依赖，可在 node 环境用 vitest 直接覆盖。
 */

/** 节点尺寸范围（力导向图 nodeVal，分数 0~100 线性映射） */
export const NODE_SIZE_MIN = 4;
export const NODE_SIZE_MAX = 12;

/**
 * 锥形连线端点半径（T18 交付项 6）：该端节点分数 0~100 线性映射到
 * [LINK_RADIUS_MIN, LINK_RADIUS_MAX]。0 分 0.35 → 100 分 2.0（约 5.7 倍差），
 * 相对节点球体半径（约 6~9）粗细差异明显但不喧宾夺主。
 */
export const LINK_RADIUS_MIN = 0.35;
export const LINK_RADIUS_MAX = 2;
/** 未观测端：固定最小半径（虚态语义，独立于分数映射） */
export const LINK_RADIUS_UNOBSERVED = 0.2;

/** 未观测节点：半透明灰态 */
export const UNOBSERVED_NODE_COLOR = "rgba(148,163,184,0.35)";
/** 虚态连线：淡灰半透明（3D 无 dash 原语，以此表达虚态） */
export const FAINT_LINK_COLOR = "rgba(148,163,184,0.22)";

/**
 * 固定环形布局半径（T18 固定大小重设计）：
 * 与组件侧固定相机距离（z=250，fov=50°）配套调定——
 * 环直径 120 + 节点半径 + 顶部标签约占 520px 容器可见高度的 ~60%。
 */
export const NETWORK_RING_RADIUS = 60;

/** 色彩分档阈值（D21）：<60 暖色警示；60~80 过渡蓝；≥80 实蓝 */
export const SCORE_BAND_WARN = 60;
export const SCORE_BAND_STRONG = 80;

/** 暖色警示带端点：0 分偏橙红 → 60 分琥珀（短板越短越警示） */
const COLOR_WARN_LOW = { r: 234, g: 88, b: 12 }; // #EA580C
const COLOR_WARN_HIGH = { r: 245, g: 158, b: 11 }; // #F59E0B
/** 过渡蓝带端点：60 分淡蓝 → 80 分主色实蓝（与列表视图主色 #2563EB 一致） */
const COLOR_MID_LOW = { r: 147, g: 197, b: 253 }; // #93C5FD
const COLOR_STRONG = { r: 37, g: 99, b: 235 }; // #2563EB

/**
 * 图例四档色（T18 交付项 6，HTML 覆盖层图例使用）：
 * 与上方色彩分档端点一一对应（较强=COLOR_STRONG、一般=COLOR_MID_LOW、
 * 较弱=COLOR_WARN_HIGH、未观测=灰态本色 #94A3B8），由 vitest 锁定一致性，
 * 避免图例与节点分档两处各自硬编码漂移。
 */
export const LEGEND_COLOR_STRONG = "#2563EB";
export const LEGEND_COLOR_MID = "#93C5FD";
export const LEGEND_COLOR_WARN = "#F59E0B";
export const LEGEND_COLOR_UNOBSERVED = "#94A3B8";

export interface NetworkNode {
  /** 节点 id = 维度名 */
  id: string;
  /** 悬浮标签（维度名 + 分数或未知） */
  label: string;
  observed: boolean;
  score: number | null;
  /** 节点体积（nodeVal） */
  size: number;
  color: string;
  /** 钉住坐标（react-force-graph-3d）：固定环形布局，引擎不再移动节点 */
  fx: number;
  fy: number;
  fz: number;
}

export interface NetworkLink {
  source: string;
  target: string;
  /** 锥形连线 source 端半径（由该端节点分数决定；未观测端取 LINK_RADIUS_UNOBSERVED） */
  sourceRadius: number;
  /** 锥形连线 target 端半径（同 sourceRadius 规则） */
  targetRadius: number;
  /** 任一端未观测 → 两端最小半径虚态 */
  faint: boolean;
  color: string;
}

export interface NetworkGraphData {
  nodes: NetworkNode[];
  links: NetworkLink[];
}

/** 分数收敛到 [0,100]；非法值按 0 处理（与 view-model 的 clampScore 同策略） */
function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, score));
}

/** 保留两位小数，避免浮点长尾进入渲染属性 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 固定环形布局坐标（T18 固定大小重设计）：
 * - 角度 = index·(2π/total)，从 +x 轴起逆时针均匀分布；
 * - xy 平面半径恒为 NETWORK_RING_RADIUS；
 * - z 轴按索引确定性交错（-15/-5/+5/+15 循环），制造 3D 纵深；
 * 纯函数、无随机性：同 index/total 必得同坐标。
 */
export function nodePositionOf(index: number, total: number): { x: number; y: number; z: number } {
  const angle = (index * 2 * Math.PI) / total;
  return {
    x: round2(NETWORK_RING_RADIUS * Math.cos(angle)),
    y: round2(NETWORK_RING_RADIUS * Math.sin(angle)),
    z: ((index % 4) - 1.5) * 10,
  };
}

/** 节点大小：分数 0~100 线性映射到 [NODE_SIZE_MIN, NODE_SIZE_MAX]（高分大、低分小） */
export function nodeSizeOf(score: number): number {
  const ratio = clampScore(score) / 100;
  return round2(NODE_SIZE_MIN + ratio * (NODE_SIZE_MAX - NODE_SIZE_MIN));
}

/**
 * 节点颜色（D21 色彩语义分档）：
 * - 未观测：固定半透明灰态（区分「未知」与低分，FR-8）；
 * - <60：暖色警示（橙红 → 琥珀，分数越低越偏橙红）；
 * - 60~80：淡蓝 → 实蓝过渡；
 * - ≥80：主色实蓝；
 * 透明度随分数 0.75~1 递增（高分更实）。
 */
export function nodeColorOf(score: number | null): string {
  if (score === null) return UNOBSERVED_NODE_COLOR;
  const clamped = clampScore(score);
  const alpha = round2(0.75 + (clamped / 100) * 0.25);
  if (clamped >= SCORE_BAND_STRONG) {
    return `rgba(${COLOR_STRONG.r},${COLOR_STRONG.g},${COLOR_STRONG.b},${alpha})`;
  }
  const { from, to, t } =
    clamped < SCORE_BAND_WARN
      ? { from: COLOR_WARN_LOW, to: COLOR_WARN_HIGH, t: clamped / SCORE_BAND_WARN }
      : {
          from: COLOR_MID_LOW,
          to: COLOR_STRONG,
          t: (clamped - SCORE_BAND_WARN) / (SCORE_BAND_STRONG - SCORE_BAND_WARN),
        };
  const channel = (low: number, high: number) => Math.round(low + t * (high - low));
  return `rgba(${channel(from.r, to.r)},${channel(from.g, to.g)},${channel(from.b, to.b)},${alpha})`;
}

/** 锥形连线单端半径：该端节点分数 0~100 线性映射到 [LINK_RADIUS_MIN, LINK_RADIUS_MAX] */
export function linkRadiusOf(score: number): number {
  const ratio = clampScore(score) / 100;
  return round2(LINK_RADIUS_MIN + ratio * (LINK_RADIUS_MAX - LINK_RADIUS_MIN));
}

/**
 * 单条连线（T18 交付项 6 锥形渐变粗细）：两端半径各由该端节点分数决定
 * （高分端粗、低分端细）；任一端未观测 → 两端最小半径虚态（faint 规则不变）。
 */
export function linkOf(a: AbilityDimensionView, b: AbilityDimensionView): NetworkLink {
  if (!a.observed || !b.observed || a.currentScore === null || b.currentScore === null) {
    return {
      source: a.dimension,
      target: b.dimension,
      sourceRadius: LINK_RADIUS_UNOBSERVED,
      targetRadius: LINK_RADIUS_UNOBSERVED,
      faint: true,
      color: FAINT_LINK_COLOR,
    };
  }
  const shortboard = Math.min(a.currentScore, b.currentScore);
  const ratio = clampScore(shortboard) / 100;
  // 短板越强连线越实，保持蓝色系与节点一致
  const alpha = round2(0.25 + ratio * 0.55);
  return {
    source: a.dimension,
    target: b.dimension,
    sourceRadius: linkRadiusOf(a.currentScore),
    targetRadius: linkRadiusOf(b.currentScore),
    faint: false,
    color: `rgba(96,165,250,${alpha})`,
  };
}

/** 维度画像 → 全连接网络图数据：8 节点 + C(8,2)=28 边，节点顺序与输入一致，坐标固定环形钉住 */
export function buildNetworkGraph(dimensions: AbilityDimensionView[]): NetworkGraphData {
  const nodes: NetworkNode[] = dimensions.map((dim, index) => {
    const position = nodePositionOf(index, dimensions.length);
    return {
      id: dim.dimension,
      label: dim.observed && dim.currentScore !== null
        ? `${dim.dimension} · ${Math.round(dim.currentScore)} 分`
        : `${dim.dimension} · 未观测`,
      observed: dim.observed,
      score: dim.currentScore,
      size: dim.observed && dim.currentScore !== null ? nodeSizeOf(dim.currentScore) : NODE_SIZE_MIN,
      color: nodeColorOf(dim.observed ? dim.currentScore : null),
      fx: position.x,
      fy: position.y,
      fz: position.z,
    };
  });
  const links: NetworkLink[] = [];
  for (let i = 0; i < dimensions.length; i += 1) {
    for (let j = i + 1; j < dimensions.length; j += 1) {
      links.push(linkOf(dimensions[i], dimensions[j]));
    }
  }
  return { nodes, links };
}
