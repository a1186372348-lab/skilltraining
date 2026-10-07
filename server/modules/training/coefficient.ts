/**
 * BR-2 独立完成系数（2026-10-05 修订，D22）：
 * 系数 = max(0.6, 1 − 0.1 × 首次提交前的提示次数 − 0.05 × 追问阶段提示次数)。
 * 追问提示半价（每次 −0.05），与首答前提示共用 0.6 下限。
 * 用整数运算实现（按 20 分制 (20 − 2n − m) / 20），避免 0.1/0.05 浮点误差
 * （如 1 − 0.3 = 0.6999…、0.85 无法精确表示）。
 * followupHintCount 缺省为 0：单参调用行为与修订前完全一致。
 */
export function independenceCoefficient(hintCount: number, followupHintCount = 0): number {
  const n = Number.isFinite(hintCount) ? Math.max(0, Math.floor(hintCount)) : 0;
  const m = Number.isFinite(followupHintCount) ? Math.max(0, Math.floor(followupHintCount)) : 0;
  // 20 分制：首答前提示每次 −2，追问提示每次 −1，下限 12（= 0.6 × 20）
  return Math.max(12, 20 - 2 * Math.min(n, 10) - m) / 20;
}
