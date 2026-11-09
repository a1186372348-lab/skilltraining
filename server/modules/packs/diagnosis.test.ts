import { describe, expect, it } from "vitest";

import { buildPackDiagnosis, type DiagnosisItem } from "./diagnosis";

function row(orderIndex: number, value: number | null): DiagnosisItem {
  return {
    orderIndex,
    session: {
      state: "scored", scoredAt: new Date("2026-10-01T00:00:00Z"),
      scores: value === null ? [] : [{ dimension: "问题定义", effectiveScore: value }],
    },
  };
}

describe("buildPackDiagnosis", () => {
  it("按题序取目标维度的有效分，不混入其他维度或把零当缺失", () => {
    const source = [row(2, 70), row(0, 0), row(1, 60), row(4, 85), row(3, 75)];
    source[0].session!.scores.push({ dimension: "用户理解", effectiveScore: 99 });
    const result = buildPackDiagnosis("问题定义", source);
    expect(result.trajectory.map(item => item.effectiveScore)).toEqual([0, 60, 70, 75, 85]);
    expect(result.average).toBe(58);
    expect(result.trend).toBe("improving");
    expect(result.band).toBe("developing");
    expect(result.advice).toContain("问题定义");
    expect(result.advice).toContain("用户");
  });

  it("结果不完整或目标维得分损坏时保留未知，不输出完整诊断", () => {
    for (const value of [null, Number.NaN, -1, 101]) {
      const result = buildPackDiagnosis("问题定义", [row(0, 70), row(1, value), row(2, 70), row(3, 70), row(4, 70)]);
      expect(result.trajectory[1].effectiveScore).toBeNull();
      expect(result.complete).toBe(false);
      expect(result.average).toBeNull();
      expect(result.advice).toBeNull();
    }
  });

  it.each([
    [59.99, "developing"], [60, "building"], [74.99, "building"], [75, "established"],
  ] as const)("均值 %s 对应 %s（建议分档而非复测门槛）", (value, band) => {
    const result = buildPackDiagnosis("问题定义", Array.from({ length: 5 }, (_, i) => row(i, value)));
    expect(result.band).toBe(band);
    expect(result.trend).toBe("stable");
  });

  it("分档使用未四舍五入的真实均值，展示再由消费方处理", () => {
    const below75 = buildPackDiagnosis("问题定义", [row(0, 74.99), ...[1, 2, 3, 4].map(i => row(i, 75))]);
    const below60 = buildPackDiagnosis("问题定义", [row(0, 59.99), ...[1, 2, 3, 4].map(i => row(i, 60))]);
    expect(below75.average).toBeCloseTo(74.998, 3);
    expect(below75.band).toBe("building");
    expect(below60.average).toBeCloseTo(59.998, 3);
    expect(below60.band).toBe("developing");
  });

  it.each([
    [54.99, "stable"], [55, "improving"], [45.01, "stable"], [45, "declining"],
  ] as const)("首尾变化到 %s 时趋势为 %s", (last, trend) => {
    const result = buildPackDiagnosis("问题定义", [row(0, 50), row(1, 50), row(2, 50), row(3, 50), row(4, last)]);
    expect(result.trend).toBe(trend);
  });

  it("未评分、重复维度分数或缺少题目时不伪造完整结果", () => {
    const unscored = row(1, 70);
    unscored.session!.state = "followup";
    unscored.session!.scoredAt = null;
    const duplicate = row(2, 70);
    duplicate.session!.scores.push({ dimension: "问题定义", effectiveScore: 80 });
    const result = buildPackDiagnosis("问题定义", [row(0, 70), unscored, duplicate]);
    expect(result.trajectory.map(item => item.effectiveScore)).toEqual([70, null, null]);
    expect(result.complete).toBe(false);
    expect(result.average).toBeNull();
  });
});
