import { describe, expect, it } from "vitest";

import {
  DEEPEN_HINT_TEXT,
  REVEAL_DIMENSIONS,
  baselineStageText,
  currentQuestionIndex,
  finishingProgressText,
  isDeepenCurrent,
  litDimensionCount,
  progressText,
  resumeBanner,
  shouldShowIntro,
  showDelayHint,
  toProgressDots,
  toRevealPreview,
  transitionContinueLabel,
  transitionProgressText,
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

describe("逐维进度点渲染模型（T27 切片 4：12 格 = total，加深题琥珀）", () => {
  it("items 驱动：位次 1 起、三态映射、加深题 isDeepen 标记（琥珀色由组件按标记渲染）", () => {
    const dots = toProgressDots({
      total: 9,
      items: [
        { questionId: "d0-a", dimension: "问题定义", orderIndex: 0, state: "scored", isDeepen: false },
        { questionId: "d0-b", dimension: "问题定义", orderIndex: 1, state: "active", isDeepen: true },
        { questionId: "d1-a", dimension: "用户理解", orderIndex: 2, state: "pending", isDeepen: false },
      ],
    });
    expect(dots).toEqual([
      { key: "d0-a", label: 1, state: "scored", isDeepen: false },
      { key: "d0-b", label: 2, state: "active", isDeepen: true },
      { key: "d1-a", label: 3, state: "pending", isDeepen: false },
    ]);
  });

  it("防御性降级：旧响应/缓存无 items → 按 total 生成 pending 占位格（不崩、格数正确）", () => {
    const dots = toProgressDots({ total: 12 });
    expect(dots).toHaveLength(12);
    expect(dots[0]).toMatchObject({ label: 1, state: "pending", isDeepen: false });
    expect(dots.every((d) => d.state === "pending" && !d.isDeepen)).toBe(true);
    expect(toProgressDots({ total: 0 })).toEqual([]);
  });
});

describe("断点续测横幅（resume 驱动，两态文案）", () => {
  it("hasInProgress=false 或 resume 缺失 → 不显示", () => {
    expect(resumeBanner(undefined)).toBeNull();
    expect(resumeBanner(null)).toBeNull();
    expect(
      resumeBanner({ hasInProgress: false, questionId: null, dimension: null, scoringPending: false }),
    ).toBeNull();
  });

  it("继续作答态：hasInProgress=true 且 scoringPending=false → 「继续基线测评」文案", () => {
    const banner = resumeBanner({
      hasInProgress: true,
      questionId: "d2-a",
      dimension: "根因分析",
      scoringPending: false,
    });
    expect(banner).not.toBeNull();
    expect(banner!.kind).toBe("continue");
    expect(banner!.title).toContain("继续");
    expect(banner!.body).toContain("进度");
  });

  it("评分/判定进行中文案：scoringPending=true → scoring 态（区分于继续作答，切片 3 遗留说明）", () => {
    const banner = resumeBanner({
      hasInProgress: true,
      questionId: null,
      dimension: null,
      scoringPending: true,
    });
    expect(banner!.kind).toBe("scoring");
    expect(banner!.title).toMatch(/评分|判定/);
    expect(banner!.body).toMatch(/自动|稍候/);
  });
});

describe("加深提示（当前题为加深题时）", () => {
  it("当前待作答题为加深且 active → 命中并给出提示文案；主题当前题 → 不命中", () => {
    const items = [
      { questionId: "d0-a", dimension: "问题定义", orderIndex: 0, state: "scored" as const, isDeepen: false },
      { questionId: "d0-b", dimension: "问题定义", orderIndex: 1, state: "active" as const, isDeepen: true },
      { questionId: "d1-a", dimension: "用户理解", orderIndex: 2, state: "pending" as const, isDeepen: false },
    ];
    expect(isDeepenCurrent(items, "d0-b")).toBe(true);
    expect(isDeepenCurrent(items, "d1-a")).toBe(false);
    expect(isDeepenCurrent(items, "d0-a")).toBe(false); // 已评分
    expect(isDeepenCurrent(undefined, "d0-b")).toBe(false); // 防御：items 缺失
    expect(DEEPEN_HINT_TEXT).toContain("再看一题");
  });
});

describe("完成页八维点亮预览模型（dimensionPreview 渲染，null = 未知态）", () => {
  it("preview 存在：有分维度点亮并给出分数字符，未知维度（null）不点亮、无分数字符", () => {
    const views = toRevealPreview(
      [
        { dimension: "问题定义", effectiveScore: 72.5 },
        { dimension: "用户理解", effectiveScore: 60 },
        { dimension: "根因分析", effectiveScore: null },
      ],
      0,
    );
    expect(views).toEqual([
      { dimension: "问题定义", state: "lit", scoreText: "72.5" },
      { dimension: "用户理解", state: "lit", scoreText: "60" },
      { dimension: "根因分析", state: "pending", scoreText: null },
    ]);
  });

  it("preview 为 null（评分中）：回退按 litCount 递进点亮（既有收尾页行为，不展示分数）", () => {
    const views = toRevealPreview(null, 3);
    expect(views).toHaveLength(REVEAL_DIMENSIONS.length);
    expect(views.filter((v) => v.state === "lit")).toHaveLength(3);
    expect(views[0].scoreText).toBeNull();
    expect(views[3].state).toBe("pending");
  });
});
