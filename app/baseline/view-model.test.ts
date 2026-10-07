import { describe, expect, it } from "vitest";

import {
  baselineStageText,
  currentQuestionIndex,
  progressText,
  shouldShowIntro,
} from "./view-model";

// /baseline 页 view-model 纯函数单测（T17a / D19）：不依赖浏览器与数据库。

describe("currentQuestionIndex / progressText：进度指示", () => {
  it("第 1 题进行中 → 第 1/2 题", () => {
    expect(currentQuestionIndex(0, 2)).toBe(1);
    expect(progressText(0, 2)).toBe("第 1/2 题");
  });

  it("第 1 题已评完 → 第 2/2 题", () => {
    expect(currentQuestionIndex(1, 2)).toBe(2);
    expect(progressText(1, 2)).toBe("第 2/2 题");
  });

  it("全部完成 → 封顶并显示已完成", () => {
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

  it("中断恢复（已有首答或已完成过题）→ 不展示", () => {
    expect(shouldShowIntro({ firstAnswer: "我的首答" }, 0)).toBe(false);
    expect(shouldShowIntro({ firstAnswer: null }, 1)).toBe(false);
  });
});
