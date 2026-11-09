import { describe, expect, it } from "vitest";

import type { FeedbackDimensionScore } from "./contract";
import {
  MAX_CONSECUTIVE_POLL_FAILURES,
  SCORING_POLL_INTERVAL_MS,
  SURVEY_QUESTIONS,
  calculationDetailLines,
  canSubmitSurvey,
  coefficientText,
  feedbackStageText,
  formatScore,
  hintUsageText,
  isStarValue,
  scoreBreakdownText,
  shouldShowPollError,
  visibleSurveyQuestions,
} from "./view-model";

// 反馈页视图模型纯函数测试（T07）：分数/系数格式化、计算过程展开文案、
// 星级问卷判定（两问必填 + D16 第三问按触发渲染）、评分轮询降级。

function dim(overrides: Partial<FeedbackDimensionScore> = {}): FeedbackDimensionScore {
  return {
    dimension: "用户理解",
    rawScore: 85,
    hintCount: 2,
    coefficient: 0.8,
    effectiveScore: 68,
    diagnosisText: "诊断文本",
    ...overrides,
  };
}

describe("分数与系数格式化", () => {
  it("常见分数保留最多两位小数，整数不补零", () => {
    expect(formatScore(68)).toBe("68");
    expect(formatScore(87.5)).toBe("87.5");
    expect(formatScore(71.28)).toBe("71.28");
    expect(formatScore(65.234)).toBe("65.23");
    expect(formatScore(65.236)).toBe("65.24");
    expect(formatScore(0)).toBe("0");
    expect(formatScore(100)).toBe("100");
  });

  it.each([
    [59.95, 60, "59.95"],
    [59.99, 60, "59.99"],
    [59.995, 60, "59.995"],
    [59.999, 60, "59.999"],
    [59.99999999999999, 60, "59.99999999999999"],
    [74.95, 75, "74.95"],
    [74.99, 75, "74.99"],
    [74.995, 75, "74.995"],
    [74.999, 75, "74.999"],
    [74.99999999999999, 75, "74.99999999999999"],
    [69.999, 70, "69.999"],
  ])("%s 分显示为 %s 以下的实际值", (score, boundary, expected) => {
    const displayed = formatScore(score);
    expect(displayed).toBe(expected);
    expect(Number(displayed)).toBeLessThan(boundary);
  });

  it.each([
    [60, 60],
    [60.00001, 60],
    [60.01, 60],
    [75, 75],
    [75.00001, 75],
    [75.01, 75],
  ])("%s 分达到 %s 时展示仍不低于该边界", (score, boundary) => {
    expect(Number(formatScore(score))).toBeGreaterThanOrEqual(boundary);
  });

  it("非法分数显示占位符", () => {
    expect(formatScore(Number.NaN)).toBe("-");
    expect(formatScore(Number.POSITIVE_INFINITY)).toBe("-");
    expect(formatScore(Number.NEGATIVE_INFINITY)).toBe("-");
  });

  it("系数保留一位小数（规避 1−0.1×n 浮点尾巴）", () => {
    expect(coefficientText(1)).toBe("1.0");
    expect(coefficientText(0.8)).toBe("0.8");
    expect(coefficientText(0.7000000000000001)).toBe("0.7");
    expect(coefficientText(Number.NaN)).toBe("1.0");
  });

  it("提示用量文案：0 次强调完全独立", () => {
    expect(hintUsageText(0)).toBe("完全独立作答");
    expect(hintUsageText(2)).toBe("用了 2 次提示");
    expect(hintUsageText(-1)).toBe("完全独立作答");
    expect(hintUsageText(Number.NaN)).toBe("完全独立作答");
  });
});

describe("有效得分行小字与「查看计算过程」（BR-1/BR-2 可解释性）", () => {
  it("小字：原始 85 × 系数 0.8（用了 2 次提示）", () => {
    expect(scoreBreakdownText(dim())).toBe("原始 85 × 系数 0.8（用了 2 次提示）");
  });

  it("小字：0 次提示显示完全独立", () => {
    expect(scoreBreakdownText(dim({ rawScore: 92, hintCount: 0, coefficient: 1 }))).toBe(
      "原始 92 × 系数 1.0（完全独立作答）",
    );
  });

  it("展开内容：等式行 + 系数规则行", () => {
    const lines = calculationDetailLines(dim());
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("有效得分 = 原始表现分 × 独立完成系数");
    expect(lines[1]).toBe("85 × 0.8 = 68");
    expect(lines[2]).toContain("用了 2 次提示");
    expect(lines[2]).toContain("最低 0.6");
  });

  it("展开内容：小数分等式行同样对齐", () => {
    const lines = calculationDetailLines(
      dim({ rawScore: 87.5, coefficient: 0.9, effectiveScore: 78.75 }),
    );
    expect(lines[1]).toBe("87.5 × 0.9 = 78.75");
  });

  it("计算过程与大号分数一致，显示边界前的实际有效分", () => {
    const score = dim({ rawScore: 74.99, hintCount: 0, coefficient: 1, effectiveScore: 74.99 });
    expect(calculationDetailLines(score)[1]).toBe("74.99 × 1.0 = 74.99");
    expect(scoreBreakdownText(score)).toContain("原始 74.99");
  });
});

describe("感知问卷（D16：两问必答 + 每 5 次训练追加周期性一问）", () => {
  it("问题清单：两问固定在前，第三问为周期性", () => {
    expect(SURVEY_QUESTIONS.map((q) => q.key)).toEqual([
      "q1Clarity",
      "q2Next",
      "periodicQ3",
    ]);
    expect(SURVEY_QUESTIONS[0]?.periodic).toBe(false);
    expect(SURVEY_QUESTIONS[2]?.periodic).toBe(true);
  });

  it("未触发时只渲染两问，触发时渲染三问", () => {
    expect(visibleSurveyQuestions(false).map((q) => q.key)).toEqual(["q1Clarity", "q2Next"]);
    expect(visibleSurveyQuestions(true).map((q) => q.key)).toEqual([
      "q1Clarity",
      "q2Next",
      "periodicQ3",
    ]);
  });

  it("星级取值校验：仅 1~5 整数", () => {
    expect(isStarValue(1)).toBe(true);
    expect(isStarValue(5)).toBe(true);
    expect(isStarValue(0)).toBe(false);
    expect(isStarValue(6)).toBe(false);
    expect(isStarValue(2.5)).toBe(false);
    expect(isStarValue(null)).toBe(false);
  });

  it("可提交判定：两问都点亮才可提交", () => {
    expect(
      canSubmitSurvey({ q1Clarity: null, q2Next: 4, periodicQ3: null }, false),
    ).toBe(false);
    expect(
      canSubmitSurvey({ q1Clarity: 4, q2Next: 5, periodicQ3: null }, false),
    ).toBe(true);
  });

  it("可提交判定：触发第三问时第三问也必答", () => {
    expect(
      canSubmitSurvey({ q1Clarity: 4, q2Next: 5, periodicQ3: null }, true),
    ).toBe(false);
    expect(
      canSubmitSurvey({ q1Clarity: 4, q2Next: 5, periodicQ3: 3 }, true),
    ).toBe(true);
  });
});

describe("评分轮询（真实延迟 35~49 秒的异步等待设计）", () => {
  it("轮询间隔与失败降级阈值", () => {
    expect(SCORING_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(2000);
    expect(MAX_CONSECUTIVE_POLL_FAILURES).toBeGreaterThanOrEqual(3);
    expect(shouldShowPollError(MAX_CONSECUTIVE_POLL_FAILURES - 1)).toBe(false);
    expect(shouldShowPollError(MAX_CONSECUTIVE_POLL_FAILURES)).toBe(true);
  });

  it("外壳阶段文案：评分中 / 已完成", () => {
    expect(feedbackStageText({ status: "scoring" })).toBe("评分中");
    expect(feedbackStageText({ status: "ready" })).toBe("已完成");
  });
});
