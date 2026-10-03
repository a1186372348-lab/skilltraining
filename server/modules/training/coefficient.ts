/**
 * BR-2 独立完成系数：系数 = max(0.6, 1 − 0.1 × 首次提交前的提示次数)。
 * 用整数运算实现（(10 − n) / 10），避免 0.1 浮点误差（如 1 − 0.3 = 0.6999…）。
 */
export function independenceCoefficient(hintCount: number): number {
  const n = Number.isFinite(hintCount) ? Math.max(0, Math.floor(hintCount)) : 0;
  return Math.max(0.6, (10 - Math.min(n, 10)) / 10);
}
