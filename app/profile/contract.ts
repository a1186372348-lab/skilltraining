/**
 * 能力画像页 API 契约（前端视角，T09）。
 *
 * 与 server/modules/profile/ability-page.ts 的响应形状对齐；
 * 统一响应封装沿用 server/lib/api-response.ts：{ success: true, data } / { success: false, error }。
 * 若联调时服务端字段有出入，只需修改本文件与 app/profile/api.ts，页面组件不感知。
 */

export type Trend = "上升" | "稳定" | "下降";
export type HintDependencyBand = "低" | "中" | "高";

/** 维度状态标签（US-008；「样本较少」优先于趋势，观察 < 3 次时不解读趋势） */
export type AbilityStatusLabel = "稳定" | "样本较少" | "↑ 上升中" | "↓ 下降中";

/** 单维度画像视图：未观测维度为未知态（observed=false，数值字段全 null，不显示 0 分） */
export interface AbilityDimensionView {
  dimension: string;
  observed: boolean;
  currentScore: number | null;
  observationCount: number;
  hintDependency: number | null;
  hintDependencyBand: HintDependencyBand | null;
  trend: Trend | null;
  /** 已观测维度必有；未观测为 null */
  statusLabel: AbilityStatusLabel | null;
  /** 近 N 次有效分（时间升序），用于趋势火花线；未观测为空数组 */
  sparkline: number[];
  /** JSON 序列化后为 ISO 字符串；未观测为 null */
  updatedAt: string | null;
}

/** 下一题优先方向（T11 自适应出题接入前的固定规则文案） */
export interface NextFocus {
  dimension: string;
  /** explore = 探索期（存在未观测维度）；strengthen = 强化期（全部已观测，攻最弱） */
  mode: "explore" | "strengthen";
  text: string;
}

/** GET /api/profile/ability 的 data 负载 */
export interface AbilityPageView {
  insight: {
    /** 已观测维度数 n（洞察条「AI 已了解你 n/8 个维度」） */
    observedCount: number;
    totalCount: number;
    nextFocus: NextFocus;
  };
  /** 固定 8 维，顺序与 ABILITY_DIMENSIONS 一致 */
  dimensions: AbilityDimensionView[];
  /** 整体提示依赖度（已观测维度提示依赖的平均与分档）；无任何观测时为 null */
  hintDependencyOverall: {
    average: number;
    band: HintDependencyBand;
  } | null;
}
