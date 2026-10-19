import { describe, expect, it } from "vitest";

import {
  baselineStageText,
  currentQuestionIndex,
  finishingProgressText,
  litDimensionCount,
  progressText,
  shouldShowIntro,
  showDelayHint,
  transitionContinueLabel,
  transitionProgressText,
  REVEAL_DIMENSIONS,
} from "./view-model";

// /baseline 页 view-model 纯函数单测（T17a / D19；T36 / D38 按作答推进）：不依赖浏览器与数据库。

describe("currentQuestionIndex / progressText：进度指示（按已作答口径，T36）", () => {
  it("第 1 题进行中 → 第 1/2 题", () => {
    expect(currentQuestionIndex(0, 2)).toBe(1);
    expect(progressText(0, 2)).toBe("第 1/2 题");
  });

  it("第 1 题已作答（不等评分）→ 第 2/2 题", () => {
    expect(currentQuestionIndex(1, 2)).toBe(2);
    expect(progressText(1, 2)).toBe("第 2/2 题");
  });

  it("全部作答 → 封顶并显示已完成", () => {
    expect(currentQuestionIndex(2, 2)).toBe(2);
    expect(progressText(2, 2)).toBe("2/2 已完成");
  });

  it("无基线题（total=0）→ 空文案，不报错", () => {
    expect(currentQuestionIndex(0, 0)).toBe(0);
    expect(progressText(0, 0)).toBe("");
  });
});

describe("baselineStageText：侧栏状态", () => {
  it("进行中显示 基线 n/total", () => {
    expect(baselineStageText(0, 2)).toBe("基线 1/2");
    expect(baselineStageText(1, 2)).toBe("基线 2/2");
  });

  it("全部完成封顶在 total", () => {
    expect(baselineStageText(2, 2)).toBe("基线 2/2");
  });
});

describe("shouldShowIntro：开场说明卡展示判定", () => {
  it("一题未做且未作答 → 展示", () => {
    expect(shouldShowIntro({ firstAnswer: null }, 0)).toBe(true);
    expect(shouldShowIntro(null, 0)).toBe(true);
  });

  it("中断恢复（已有首答或已作答过题）→ 不展示", () => {
    expect(shouldShowIntro({ firstAnswer: "我的首答" }, 0)).toBe(false);
    expect(shouldShowIntro({ firstAnswer: null }, 1)).toBe(false);
  });
});

describe("finishingProgressText / litDimensionCount：收尾页揭晓进度（T36 / D38）", () => {
  it("按已评分数输出「已完成 n/total 项能力分析」", () => {
    expect(finishingProgressText(0, 8)).toBe("已完成 0/8 项能力分析");
    expect(finishingProgressText(5, 8)).toBe("已完成 5/8 项能力分析");
    expect(finishingProgressText(8, 8)).toBe("已完成 8/8 项能力分析");
  });

  it("total=0 → 空文案，不报错", () => {
    expect(finishingProgressText(0, 0)).toBe("");
  });

  it("揭晓维度固定为 8 个能力一级维度", () => {
    expect(REVEAL_DIMENSIONS).toHaveLength(8);
  });

  it("点亮数按评分完成比例递进并封顶", () => {
    expect(litDimensionCount(0, 8)).toBe(0);
    expect(litDimensionCount(4, 8)).toBe(4);
    expect(litDimensionCount(8, 8)).toBe(8);
    // 题数与维度数不一致时按比例折算；评分超出 total 时封顶
    expect(litDimensionCount(1, 2)).toBe(4);
    expect(litDimensionCount(9, 8)).toBe(8);
    expect(litDimensionCount(1, 0)).toBe(0);
  });
});

describe("showDelayHint：收尾页超时提示（约 3 分钟）", () => {
  it("未超过 3 分钟不提示，达到即提示", () => {
    expect(showDelayHint(0)).toBe(false);
    expect(showDelayHint(3 * 60 * 1000 - 1)).toBe(false);
    expect(showDelayHint(3 * 60 * 1000)).toBe(true);
    expect(showDelayHint(10 * 60 * 1000)).toBe(true);
  });
});

describe("题间过渡卡（T36 试测修订：提交后手动进入下一题，不再立刻切题）", () => {
  it("transitionProgressText：已完成 n/total 题；total=0 时空文案", () => {
    expect(transitionProgressText(1, 8)).toBe("已完成 1/8 题");
    expect(transitionProgressText(8, 8)).toBe("已完成 8/8 题");
    expect(transitionProgressText(9, 8)).toBe("已完成 8/8 题"); // 封顶
    expect(transitionProgressText(0, 0)).toBe("");
  });

  it("transitionContinueLabel：中途「进入下一题 →」，最后一题「完成测评，查看能力边界 →」", () => {
    expect(transitionContinueLabel(1, 8)).toBe("进入下一题 →");
    expect(transitionContinueLabel(7, 8)).toBe("进入下一题 →");
    expect(transitionContinueLabel(8, 8)).toBe("完成测评，查看能力边界 →");
    expect(transitionContinueLabel(0, 0)).toBe("进入下一题 →"); // 无题兜底
  });
});
