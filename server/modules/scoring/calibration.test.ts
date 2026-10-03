import { describe, expect, it } from "vitest";

import {
  CALIBRATION_SAMPLES,
  createMockScorer,
  formatCalibrationReport,
  runCalibration,
} from "./calibration";
import type { RubricScoringOutput } from "./rubric-scorer";

// 评分校准回归（R1）单元测试：全程 mock 评分器，离线运行。

describe("CALIBRATION_SAMPLES：内置校准集", () => {
  it("2~3 例固定样例，期望分数带与 Rubric 维度一一对应", () => {
    expect(CALIBRATION_SAMPLES.length).toBeGreaterThanOrEqual(2);
    expect(CALIBRATION_SAMPLES.length).toBeLessThanOrEqual(3);
    for (const sample of CALIBRATION_SAMPLES) {
      const dims = Object.keys(sample.input.rubricDimensions);
      expect(Object.keys(sample.expectedBands).sort()).toEqual(dims.sort());
      for (const [low, high] of Object.values(sample.expectedBands)) {
        expect(low).toBeLessThanOrEqual(high);
        expect(low).toBeGreaterThanOrEqual(0);
        expect(high).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("runCalibration：漂移检测", () => {
  it("mock 模式：确定性桩评分落在分数带内，回归通过", async () => {
    const report = await runCalibration(CALIBRATION_SAMPLES, createMockScorer(), {
      mode: "mock",
    });
    expect(report.mode).toBe("mock");
    expect(report.samples).toHaveLength(CALIBRATION_SAMPLES.length);
    expect(report.passed).toBe(true);
    expect(report.outOfBandDimensions).toBe(0);
    expect(report.totalDimensions).toBeGreaterThan(0);
    for (const sample of report.samples) {
      expect(sample.inBand).toBe(true);
      for (const d of sample.dimensions) {
        expect(d.inBand).toBe(true);
        expect(d.drift).toBe(0);
      }
    }
  });

  it("分数漂出期望带：标记带外并给出漂移量（超出边界的距离）", async () => {
    const [sample] = CALIBRATION_SAMPLES;
    const scorer = async (): Promise<RubricScoringOutput> => ({
      dimensions: Object.entries(sample.expectedBands).map(([dimension, [, high]]) => ({
        dimension,
        rawScore: high + 17, // 故意高出带上界（桩分数允许越界，校验归 rubric-scorer 管）
        diagnosis: "stub 诊断",
      })),
      topIssue: "stub 问题",
      nextFocus: "stub 方向",
    });

    const report = await runCalibration([sample], scorer, { mode: "mock" });
    expect(report.passed).toBe(false);
    expect(report.outOfBandDimensions).toBe(report.totalDimensions);
    const first = report.samples[0].dimensions[0];
    expect(first.inBand).toBe(false);
    expect(first.drift).toBeGreaterThan(0);
  });

  it("低于带下界同样检出（负向漂移取绝对距离）", async () => {
    const [sample] = CALIBRATION_SAMPLES;
    const [firstDim, [low]] = Object.entries(sample.expectedBands)[0];
    const scorer = async (): Promise<RubricScoringOutput> => ({
      dimensions: Object.keys(sample.expectedBands).map((dimension) => ({
        dimension,
        rawScore: dimension === firstDim ? low - 10 : (sample.expectedBands[dimension][0] + sample.expectedBands[dimension][1]) / 2,
        diagnosis: "stub 诊断",
      })),
      topIssue: "stub 问题",
      nextFocus: "stub 方向",
    });

    const report = await runCalibration([sample], scorer, { mode: "mock" });
    const drifted = report.samples[0].dimensions.find((d) => d.dimension === firstDim)!;
    expect(drifted.inBand).toBe(false);
    expect(drifted.drift).toBeCloseTo(10, 5);
  });
});

describe("formatCalibrationReport：漂移报告输出", () => {
  it("包含模式、样例 id、逐维度分数与分数带、汇总结论", async () => {
    const report = await runCalibration(CALIBRATION_SAMPLES, createMockScorer(), {
      mode: "mock",
    });
    const text = formatCalibrationReport(report);
    expect(text).toContain("mock");
    for (const sample of CALIBRATION_SAMPLES) {
      expect(text).toContain(sample.id);
    }
    expect(text).toMatch(/通过|PASS/i);
    expect(text).toMatch(/\d+\/\d+/); // 带内维度计数
  });

  it("回归失败时报告标出失败样例与维度", async () => {
    const [sample] = CALIBRATION_SAMPLES;
    const scorer = async (): Promise<RubricScoringOutput> => ({
      dimensions: Object.keys(sample.expectedBands).map((dimension) => ({
        dimension,
        rawScore: 0,
        diagnosis: "stub 诊断",
      })),
      topIssue: "stub 问题",
      nextFocus: "stub 方向",
    });
    const report = await runCalibration([sample], scorer, { mode: "mock" });
    const text = formatCalibrationReport(report);
    expect(text).toMatch(/失败|FAIL/i);
    expect(text).toContain(sample.id);
  });
});
