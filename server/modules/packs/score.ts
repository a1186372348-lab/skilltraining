export interface DimensionScore {
  dimension: string;
  effectiveScore: number;
}

/** 缺失、重复或范围外评分一律未知，零分是有效值。 */
export function targetEffectiveScore(scores: readonly DimensionScore[], dimension: string): number | null {
  const matching = scores.filter(score => score.dimension === dimension);
  if (matching.length !== 1) return null;
  const value = matching[0].effectiveScore;
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}
