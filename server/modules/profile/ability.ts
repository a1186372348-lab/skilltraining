import type { PrismaClient } from "@prisma/client";

import { ABILITY_DIMENSIONS } from "./schema";

/**
 * 能力画像的读写（BR-6 / FR-6 / FR-8 / Prd.md 图 3）。
 *
 * - 维度当前分 = 该用户该维度历史有效分（scores.effective_score）简单平均；
 * - 观察次数 = 该维度有效评分数，随评分累计；
 * - 提示依赖 = 近 N 次有效评分的提示次数平均（存数值，展示层按 低/中/高 分档），
 *   供「同分不同病」差异化诊断（BR-6）；
 * - 趋势 = 与上次分数比较（±0.5 分内记稳定，避免均值噪声抖动）；
 * - 未知维度保持 NULL 不建档：无有效评分的维度不写 ability_profiles，
 *   读取时以全 8 维视图补齐未知态（区分「未知」与低分，FR-8）。
 *
 * T06 新增；不改变本模块既有 T04 对外契约（repository.ts / schema.ts 保持原样）。
 */

/** 画像更新的最小数据库依赖：PrismaClient 与事务客户端都满足 */
export type AbilityDbClient = Pick<PrismaClient, "score" | "abilityProfile">;

/** 提示依赖观察窗口：近 N 次有效评分（BR-6「近期」提示依赖特征） */
export const HINT_DEPENDENCY_WINDOW = 5;

/** 趋势判定阈值（分）：与上次分数差超过该值才记为上升/下降 */
const TREND_EPSILON = 0.5;

export type Trend = "上升" | "稳定" | "下降";
export type HintDependencyBand = "低" | "中" | "高";

/** 保留两位小数：避免 0.8 等系数带来的二进制浮点长尾落库 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 提示依赖分档：<1 低（基本独立作答）；1~2.5 中；>2.5 高（频繁依赖提示） */
export function hintDependencyBand(value: number | null): HintDependencyBand | null {
  if (value === null) return null;
  if (value < 1) return "低";
  if (value <= 2.5) return "中";
  return "高";
}

function computeTrend(previous: number | null, current: number): Trend | null {
  if (previous === null) return null; // 首次观测无上次可比
  const diff = current - previous;
  if (diff > TREND_EPSILON) return "上升";
  if (diff < -TREND_EPSILON) return "下降";
  return "稳定";
}

/**
 * 按 scores 表重算并 upsert 指定维度的画像（评分落库后在同一事务内调用）。
 * 以 scores 为唯一事实源：重复调用幂等，不会重复累计观察次数。
 */
export async function refreshAbilityProfile(
  db: AbilityDbClient,
  userId: string,
  dimensions: string[],
): Promise<void> {
  for (const dimension of [...new Set(dimensions)]) {
    const aggregate = await db.score.aggregate({
      where: { dimension, session: { userId } },
      _avg: { effectiveScore: true },
      _count: { _all: true },
    });
    const observationCount = aggregate._count._all;
    const average = aggregate._avg.effectiveScore;
    // 未知维度保持 NULL 不建档（BR-6/FR-8）
    if (observationCount === 0 || average === null) continue;

    const recent = await db.score.findMany({
      where: { dimension, session: { userId } },
      orderBy: { session: { scoredAt: "desc" } },
      take: HINT_DEPENDENCY_WINDOW,
      select: { hintCount: true },
    });
    const hintDependency = round2(
      recent.reduce((sum, row) => sum + row.hintCount, 0) / recent.length,
    );
    const currentScore = round2(average);

    const previous = await db.abilityProfile.findUnique({
      where: { userId_dimension: { userId, dimension } },
    });
    const trend = computeTrend(previous?.currentScore ?? null, currentScore);

    await db.abilityProfile.upsert({
      where: { userId_dimension: { userId, dimension } },
      create: { userId, dimension, currentScore, observationCount, hintDependency, trend },
      update: { currentScore, observationCount, hintDependency, trend },
    });
  }
}

export interface AbilityProfileDimensionView {
  dimension: string;
  /** 是否已观测（false 即未知态，展示空态而非 0 分，FR-8） */
  observed: boolean;
  currentScore: number | null;
  observationCount: number;
  /** 近 N 次平均提示次数（数值），展示层可配 hintDependencyBand 分档 */
  hintDependency: number | null;
  hintDependencyBand: HintDependencyBand | null;
  trend: Trend | null;
  updatedAt: Date | null;
}

/** 按用户读取全 8 维画像视图：未观测维度补齐未知态（NULL），顺序固定 */
export async function getAbilityProfileView(
  db: AbilityDbClient,
  userId: string,
): Promise<AbilityProfileDimensionView[]> {
  const rows = await db.abilityProfile.findMany({ where: { userId } });
  const byDimension = new Map(rows.map((row) => [row.dimension, row]));
  return ABILITY_DIMENSIONS.map((dimension) => {
    const row = byDimension.get(dimension);
    if (!row || row.currentScore === null) {
      return {
        dimension,
        observed: false,
        currentScore: null,
        observationCount: 0,
        hintDependency: null,
        hintDependencyBand: null,
        trend: null,
        updatedAt: null,
      };
    }
    return {
      dimension,
      observed: true,
      currentScore: row.currentScore,
      observationCount: row.observationCount,
      hintDependency: row.hintDependency,
      hintDependencyBand: hintDependencyBand(row.hintDependency),
      trend: (row.trend as Trend | null) ?? null,
      updatedAt: row.updatedAt,
    };
  });
}
