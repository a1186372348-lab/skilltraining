import { describe, expect, it } from "vitest";

import type { AbilityDimensionView, AbilityPageView } from "./contract";
import {
  diagnosisLineOf,
  featureLineOf,
  formatProfileScore,
  gaugeLevelOf,
  insightText,
  isGuideState,
  observationText,
  sparklineGeometry,
  sparklineStroke,
  statusTagClass,
  weakestObservedDimension,
} from "./view-model";

// 能力画像页视图模型测试（T09 / US-008 / FR-8 / BR-6）。
// 覆盖：整页降级（全部未知）、洞察条文案、大号分数格式、趋势火花线几何与配色、
// 状态标签样式、最弱维度挑选、弱项特征与诊断（同分不同病）、提示依赖仪表条。

/** 构造维度视图（默认未观测，按需覆盖字段） */
function dim(dimension: string, overrides: Partial<AbilityDimensionView> = {}): AbilityDimensionView {
  return {
    dimension,
    observed: false,
    currentScore: null,
    observationCount: 0,
    hintDependency: null,
    hintDependencyBand: null,
    trend: null,
    statusLabel: null,
    sparkline: [],
    updatedAt: null,
    ...overrides,
  };
}

const DIMENSION_ORDER = [
  "问题定义",
  "用户理解",
  "根因分析",
  "产品价值判断",
  "方案设计",
  "产品取舍",
  "指标与验证",
  "产品表达",
];

/** 构造页面视图：默认 8 维全未知，observed 指定已观测维度 */
function pageView(
  observed: Partial<AbilityDimensionView>[] = [],
  options: { nextFocusText?: string } = {},
): AbilityPageView {
  const dimensions = DIMENSION_ORDER.map((dimension, index) =>
    index < observed.length ? dim(dimension, { observed: true, ...observed[index] }) : dim(dimension),
  );
  const observedCount = observed.length;
  const firstUnknown = dimensions.find((d) => !d.observed);
  return {
    insight: {
      observedCount,
      totalCount: 8,
      nextFocus: firstUnknown
        ? {
            dimension: firstUnknown.dimension,
            mode: "explore",
            text: options.nextFocusText ?? `下一题将优先探索「${firstUnknown.dimension}」`,
          }
        : {
            dimension: "产品表达",
            mode: "strengthen",
            text: options.nextFocusText ?? "下一题将优先强化「产品表达」",
          },
    },
    dimensions,
    hintDependencyOverall:
      observedCount > 0 ? { average: 2, band: "中" } : null,
  };
}

describe("isGuideState：整页降级（T09 失败与回滚）", () => {
  it("8 维全部未观测 → 引导态", () => {
    expect(isGuideState(pageView([]))).toBe(true);
  });

  it("存在任一已观测维度 → 正常画像页", () => {
    expect(isGuideState(pageView([{ currentScore: 70, observationCount: 1 }]))).toBe(false);
  });
});

describe("insightText：顶部洞察条", () => {
  it("全部未知：0/8 + 探索方向", () => {
    expect(insightText(pageView([]))).toBe(
      "AI 已了解你 0/8 个维度 · 下一题将优先探索「问题定义」",
    );
  });

  it("部分观测：n/8 + 服务端给定的方向文案", () => {
    const view = pageView([{ currentScore: 70, observationCount: 3 }]);
    expect(insightText(view)).toBe(
      "AI 已了解你 1/8 个维度 · 下一题将优先探索「用户理解」",
    );
  });

  it("全部观测：8/8 + 强化方向", () => {
    const view = pageView(DIMENSION_ORDER.map(() => ({ currentScore: 70, observationCount: 3 })));
    expect(insightText(view)).toBe(
      "AI 已了解你 8/8 个维度 · 下一题将优先强化「产品表达」",
    );
  });
});

describe("formatProfileScore / observationText：行内数字展示", () => {
  it("大号分数：整数去小数，最多一位小数；非法值占位", () => {
    expect(formatProfileScore(75)).toBe("75");
    expect(formatProfileScore(72.5)).toBe("72.5");
    expect(formatProfileScore(61.25)).toBe("61.3");
    expect(formatProfileScore(Number.NaN)).toBe("-");
  });

  it("观察次数文案", () => {
    expect(observationText(1)).toBe("观察 1 次");
    expect(observationText(4)).toBe("观察 4 次");
  });
});

describe("sparklineGeometry：趋势火花线几何", () => {
  it("空序列（未观测）：无几何（不渲染）", () => {
    expect(sparklineGeometry([])).toBeNull();
  });

  it("单点（单维度首次观测）：水平短线，末端圆点在右端", () => {
    const geo = sparklineGeometry([70], 120, 32, 8);
    expect(geo).not.toBeNull();
    // 70 分 → y = 8 + (1 - 0.7) * (32 - 16) = 8 + 4.8 = 12.8
    expect(geo!.points).toBe("8,12.8 112,12.8");
    expect(geo!.end).toEqual({ x: 112, y: 12.8 });
  });

  it("多点：x 均匀铺开，分数越高 y 越小；0 分贴底、100 分贴顶", () => {
    const geo = sparklineGeometry([0, 50, 100], 120, 32, 8);
    expect(geo!.points).toBe("8,24 60,16 112,8");
    expect(geo!.end).toEqual({ x: 112, y: 8 });
  });

  it("超出 0~100 的脏数据按边界截断，不产生越界坐标", () => {
    const geo = sparklineGeometry([-10, 120], 120, 32, 8);
    expect(geo!.points).toBe("8,24 112,8");
  });
});

describe("sparklineStroke / statusTagClass：趋势与标签的视觉映射", () => {
  it("上升趋势用主色，其余灰色", () => {
    expect(sparklineStroke("上升")).toBe("#2563EB");
    expect(sparklineStroke("稳定")).toBe("#94A3B8");
    expect(sparklineStroke("下降")).toBe("#94A3B8");
    expect(sparklineStroke(null)).toBe("#94A3B8");
  });

  it("状态标签样式：稳定绿 / 样本较少灰 / 上升蓝 / 下降灰", () => {
    expect(statusTagClass("稳定")).toContain("#ECFDF5");
    expect(statusTagClass("样本较少")).toContain("#F1F5F9");
    expect(statusTagClass("↑ 上升中")).toContain("#EFF5FF");
    expect(statusTagClass("↓ 下降中")).toContain("#F1F5F9");
  });
});

describe("weakestObservedDimension：最弱维度（默认展开诊断）", () => {
  it("无已观测维度 → null", () => {
    expect(weakestObservedDimension(pageView([]).dimensions)).toBeNull();
  });

  it("单维度 → 该维度", () => {
    const view = pageView([{ currentScore: 70, observationCount: 3 }]);
    expect(weakestObservedDimension(view.dimensions)?.dimension).toBe("问题定义");
  });

  it("多维度取最低分；同分取观察次数较少者", () => {
    const view = pageView([
      { currentScore: 70, observationCount: 3 },
      { currentScore: 61, observationCount: 2 },
      { currentScore: 61, observationCount: 5 },
    ]);
    expect(weakestObservedDimension(view.dimensions)?.dimension).toBe("用户理解");
  });
});

describe("featureLineOf / diagnosisLineOf：弱项特征与诊断（BR-6 同分不同病）", () => {
  const base = { currentScore: 61, observationCount: 3 };

  it("高提示依赖：过程依赖脚手架，诊断指向独立构建框架", () => {
    const d = dim("产品取舍", { ...base, hintDependency: 3, hintDependencyBand: "高" });
    expect(featureLineOf(d)).toContain("提示");
    expect(diagnosisLineOf(d)).toContain("独立");
  });

  it("中提示依赖：偶用提示，诊断指向巩固独立性", () => {
    const d = dim("产品取舍", { ...base, hintDependency: 1.5, hintDependencyBand: "中" });
    expect(featureLineOf(d)).toContain("偶用提示");
    expect(diagnosisLineOf(d)).toContain("独立性");
  });

  it("低提示依赖：分数即真实水平，诊断指向分析深度", () => {
    const d = dim("产品取舍", { ...base, hintDependency: 0.2, hintDependencyBand: "低" });
    expect(featureLineOf(d)).toContain("独立");
    expect(diagnosisLineOf(d)).toContain("深度");
  });

  it("分档缺失（样本极少）：保守文案，提示继续训练", () => {
    const d = dim("产品取舍", { currentScore: 61, observationCount: 1 });
    expect(featureLineOf(d)).toContain("样本");
    expect(diagnosisLineOf(d)).toContain("更多");
  });

  it("同样的低分因提示依赖不同而文案不同（同分不同病）", () => {
    const low = dim("产品取舍", { ...base, hintDependencyBand: "低" });
    const high = dim("产品取舍", { ...base, hintDependencyBand: "高" });
    expect(featureLineOf(low)).not.toBe(featureLineOf(high));
    expect(diagnosisLineOf(low)).not.toBe(diagnosisLineOf(high));
  });
});

describe("gaugeLevelOf：整体提示依赖度 5 段仪表", () => {
  it("低/中/高 → 1/3/5 段（低靠左、高靠右），未知不点亮", () => {
    expect(gaugeLevelOf("低")).toBe(1);
    expect(gaugeLevelOf("中")).toBe(3);
    expect(gaugeLevelOf("高")).toBe(5);
    expect(gaugeLevelOf(null)).toBe(0);
  });
});
