import { targetEffectiveScore } from "./score";

export interface DiagnosisItem {
  orderIndex: number;
  session: { state: string; scoredAt: Date | null; scores: { dimension: string; effectiveScore: number }[] } | null;
}

export interface PackDiagnosis {
  trajectory: { orderIndex: number; effectiveScore: number | null }[];
  complete: boolean;
  average: number | null;
  trend: "improving" | "stable" | "declining" | null;
  band: "developing" | "building" | "established" | null;
  advice: string | null;
}

const ACTIONS: Record<string, string> = {
  问题定义: "写清目标用户、问题与验证证据",
  用户理解: "列出用户需求并设计访谈或行为验证",
  根因分析: "列出可能原因并逐项设计排查方法",
  产品价值判断: "分别写出用户价值、业务价值及依据",
  方案设计: "围绕核心问题比较方案和关键步骤",
  产品取舍: "列出备选方案、选择标准和放弃代价",
  指标与验证: "选择核心指标并写出验证办法",
  产品表达: "先写结论，再列出最关键的判断依据",
};

function scoreOf(item: DiagnosisItem, dimension: string): number | null {
  const session = item.session;
  if (!session || session.state !== "scored" || !session.scoredAt) return null;
  return targetEffectiveScore(session.scores, dimension);
}

function adviceFor(dimension: string, band: NonNullable<PackDiagnosis["band"]>, trend: NonNullable<PackDiagnosis["trend"]>): string {
  const level = { developing: "先巩固基础", building: "继续提高稳定性", established: "尝试更复杂的场景" }[band];
  const direction = { improving: "近期在进步", stable: "近期表现平稳", declining: "近期表现下降" }[trend];
  return `${dimension}：${direction}，${level}；${ACTIONS[dimension] ?? "写出判断、依据与验证方法"}。`;
}

/** 建议分档与趋势仅用于本包诊断，不是复测通过门槛。 */
export function buildPackDiagnosis(dimension: string, items: readonly DiagnosisItem[]): PackDiagnosis {
  const trajectory = [...items].sort((a, b) => a.orderIndex - b.orderIndex)
    .map(item => ({ orderIndex: item.orderIndex, effectiveScore: scoreOf(item, dimension) }));
  const complete = trajectory.length === 5 && trajectory.every((item, index) => item.orderIndex === index && item.effectiveScore !== null);
  if (!complete) return { trajectory, complete: false, average: null, trend: null, band: null, advice: null };
  const values = trajectory.map(item => item.effectiveScore as number);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const difference = values[values.length - 1] - values[0];
  const trend = difference >= 5 ? "improving" : difference <= -5 ? "declining" : "stable";
  const band = average < 60 ? "developing" : average < 75 ? "building" : "established";
  return { trajectory, complete: true, average, trend, band, advice: adviceFor(dimension, band, trend) };
}
