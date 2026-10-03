import { describe, expect, it } from "vitest";

import type { AbilityProfileDimensionView } from "./ability";
import {
  nextFocusOf,
  overallHintDependencyOf,
  statusLabelOf,
} from "./ability-page";
import { ABILITY_DIMENSIONS } from "./schema";

// 能力画像页装配纯函数测试（T09 / US-008 / FR-8 / BR-6）。
// 覆盖：状态标签（稳定/样本较少/↑上升中/↓下降中）、下一题优先方向规则
// （探索期/强化期，T11 接入点前的固定规则）、整体提示依赖度聚合。
// DB 读取（getAbilityPageView）由 app/api/profile/ability/route.test.ts 集成覆盖。

/** 构造一个维度的画像视图（默认未观测，按需覆盖字段） */
function dimView(
  dimension: string,
  overrides: Partial<AbilityProfileDimensionView> = {},
): AbilityProfileDimensionView {
  return {
    dimension,
    observed: false,
    currentScore: null,
    observationCount: 0,
    hintDependency: null,
    hintDependencyBand: null,
    trend: null,
    updatedAt: null,
    ...overrides,
  };
}

/** 构造 8 维全未知视图 */
function allUnknown(): AbilityProfileDimensionView[] {
  return ABILITY_DIMENSIONS.map((dimension) => dimView(dimension));
}

describe("statusLabelOf：维度状态标签", () => {
  it("观察次数不足 3 一律为「样本较少」（即使趋势上升）", () => {
    expect(statusLabelOf(0, null)).toBe("样本较少");
    expect(statusLabelOf(1, null)).toBe("样本较少");
    expect(statusLabelOf(2, "上升")).toBe("样本较少");
    expect(statusLabelOf(2, "下降")).toBe("样本较少");
  });

  it("样本充足（≥3）时按趋势打标", () => {
    expect(statusLabelOf(3, "上升")).toBe("↑ 上升中");
    expect(statusLabelOf(5, "下降")).toBe("↓ 下降中");
    expect(statusLabelOf(3, "稳定")).toBe("稳定");
  });

  it("样本充足但暂无趋势（首次观测后未再比较）：按稳定展示", () => {
    expect(statusLabelOf(3, null)).toBe("稳定");
  });
});

describe("nextFocusOf：下一题优先方向（固定规则，T11 接入点）", () => {
  it("全部未知：探索期，优先探索维度序第一个（问题定义）", () => {
    const focus = nextFocusOf(allUnknown());
    expect(focus.mode).toBe("explore");
    expect(focus.dimension).toBe("问题定义");
    expect(focus.text).toBe("下一题将优先探索「问题定义」");
  });

  it("部分观测：优先探索维度序上的第一个未观测维度", () => {
    const dims = allUnknown();
    dims[0] = dimView("问题定义", { observed: true, currentScore: 70, observationCount: 3 });
    dims[1] = dimView("用户理解", { observed: true, currentScore: 80, observationCount: 4 });
    const focus = nextFocusOf(dims);
    expect(focus.mode).toBe("explore");
    expect(focus.dimension).toBe("根因分析");
    expect(focus.text).toBe("下一题将优先探索「根因分析」");
  });

  it("全部观测：强化期，优先强化当前分最低的维度", () => {
    const dims = ABILITY_DIMENSIONS.map((dimension, index) =>
      dimView(dimension, {
        observed: true,
        currentScore: 90 - index, // 产品表达最低（83→... ），最后一个最低
        observationCount: 4,
      }),
    );
    const focus = nextFocusOf(dims);
    expect(focus.mode).toBe("strengthen");
    expect(focus.dimension).toBe("产品表达");
    expect(focus.text).toBe("下一题将优先强化「产品表达」");
  });

  it("全部观测且同分：取观察次数较少者；仍相同取维度序前者", () => {
    const dims = ABILITY_DIMENSIONS.map((dimension) =>
      dimView(dimension, { observed: true, currentScore: 70, observationCount: 4 }),
    );
    // 根因分析观察次数更少 → 优先强化根因分析
    dims[2] = dimView("根因分析", { observed: true, currentScore: 70, observationCount: 3 });
    expect(nextFocusOf(dims).dimension).toBe("根因分析");

    // 完全同分同次数 → 维度序第一（问题定义）
    expect(nextFocusOf(dims.map((d) => ({ ...d, observationCount: 4 }))).dimension).toBe(
      "问题定义",
    );
  });
});

describe("overallHintDependencyOf：整体提示依赖度", () => {
  it("全部未知：无整体依赖度（null，仪表条显示未知）", () => {
    expect(overallHintDependencyOf(allUnknown())).toBeNull();
  });

  it("单维度：整体依赖度即该维度数值与分档", () => {
    const dims = allUnknown();
    dims[0] = dimView("问题定义", {
      observed: true,
      currentScore: 70,
      observationCount: 3,
      hintDependency: 2,
      hintDependencyBand: "中",
    });
    expect(overallHintDependencyOf(dims)).toEqual({ average: 2, band: "中" });
  });

  it("多维度取平均并按既有规则分档：低/中/高", () => {
    const dims = allUnknown();
    dims[0] = dimView("问题定义", { observed: true, currentScore: 70, observationCount: 3, hintDependency: 0.4, hintDependencyBand: "低" });
    dims[1] = dimView("用户理解", { observed: true, currentScore: 80, observationCount: 4, hintDependency: 0.5, hintDependencyBand: "低" });
    // (0.4 + 0.5) / 2 = 0.45 → 低
    expect(overallHintDependencyOf(dims)).toEqual({ average: 0.45, band: "低" });

    dims[2] = dimView("根因分析", { observed: true, currentScore: 60, observationCount: 5, hintDependency: 4.65, hintDependencyBand: "高" });
    // (0.4 + 0.5 + 4.65) / 3 = 1.85 → 中
    expect(overallHintDependencyOf(dims)).toEqual({ average: 1.85, band: "中" });

    const high = allUnknown();
    high[0] = dimView("问题定义", { observed: true, currentScore: 60, observationCount: 3, hintDependency: 3, hintDependencyBand: "高" });
    high[1] = dimView("用户理解", { observed: true, currentScore: 60, observationCount: 3, hintDependency: 4, hintDependencyBand: "高" });
    // 3.5 → 高
    expect(overallHintDependencyOf(high)).toEqual({ average: 3.5, band: "高" });
  });

  it("已观测维度缺失提示依赖数值时不参与平均", () => {
    const dims = allUnknown();
    dims[0] = dimView("问题定义", { observed: true, currentScore: 70, observationCount: 3 });
    dims[1] = dimView("用户理解", {
      observed: true,
      currentScore: 80,
      observationCount: 4,
      hintDependency: 1,
      hintDependencyBand: "中",
    });
    expect(overallHintDependencyOf(dims)).toEqual({ average: 1, band: "中" });

    // 全部缺失数值 → null
    const none = allUnknown();
    none[0] = dimView("问题定义", { observed: true, currentScore: 70, observationCount: 3 });
    expect(overallHintDependencyOf(none)).toBeNull();
  });
});
