import { describe, expect, it } from "vitest";

import type { AbilityDimensionView } from "./contract";
import {
  LEGEND_COLOR_MID,
  LEGEND_COLOR_STRONG,
  LEGEND_COLOR_UNOBSERVED,
  LEGEND_COLOR_WARN,
  LINK_RADIUS_MAX,
  LINK_RADIUS_MIN,
  LINK_RADIUS_UNOBSERVED,
  NETWORK_RING_RADIUS,
  NODE_SIZE_MAX,
  NODE_SIZE_MIN,
  buildNetworkGraph,
  linkOf,
  linkRadiusOf,
  nodeColorOf,
  nodePositionOf,
  nodeSizeOf,
} from "./network-model";

// 能力画像 3D 网络图映射纯函数测试（T16 / D20；T18 / D21 色彩语义分档 + 固定环形布局 +
// 交付项 6 锥形渐变连线）。覆盖：节点大小（分数归一化）、节点颜色分档（<60 暖色警示 /
// 60~80 过渡蓝 / ≥80 实蓝 / 未观测半透明灰态）、全连接 28 边、锥形连线两端半径规则
//（各由该端分数线性映射、高分端粗低分端细）、任一端未观测的最小半径虚态、
// 固定环形布局（半径恒定、角度均匀、z 交错确定、无随机性）、图例色与分档端点一致。

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

/** 构造维度视图（默认未观测，按需覆盖字段；与 view-model.test.ts 夹具同形） */
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
    recentEvaluations: [],
    recentScores: [],
    updatedAt: null,
    ...overrides,
  };
}

function observed(dimension: string, currentScore: number): AbilityDimensionView {
  return dim(dimension, { observed: true, currentScore, observationCount: 3 });
}

describe("nodeSizeOf：节点大小（分数归一化）", () => {
  it("0 分最小、100 分最大、中间线性插值", () => {
    expect(nodeSizeOf(0)).toBe(NODE_SIZE_MIN);
    expect(nodeSizeOf(100)).toBe(NODE_SIZE_MAX);
    const mid = nodeSizeOf(50);
    expect(mid).toBeGreaterThan(NODE_SIZE_MIN);
    expect(mid).toBeLessThan(NODE_SIZE_MAX);
    expect(mid).toBeCloseTo((NODE_SIZE_MIN + NODE_SIZE_MAX) / 2, 2);
  });

  it("分数越高节点越大（单调递增）", () => {
    expect(nodeSizeOf(80)).toBeGreaterThan(nodeSizeOf(40));
  });

  it("越界与非法分数按边界收敛，不抛错", () => {
    expect(nodeSizeOf(-5)).toBe(NODE_SIZE_MIN);
    expect(nodeSizeOf(120)).toBe(NODE_SIZE_MAX);
    expect(nodeSizeOf(Number.NaN)).toBe(NODE_SIZE_MIN);
  });
});

describe("nodeColorOf：节点颜色（D21 分档：<60 暖色警示 / 60~80 过渡蓝 / ≥80 实蓝 / 未观测灰）", () => {
  const channelsOf = (color: string) => {
    const match = color.match(/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/);
    if (!match) throw new Error(`非 rgba 颜色：${color}`);
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), alpha: Number(match[4]) };
  };

  it("未观测：半透明灰态", () => {
    expect(nodeColorOf(null)).toBe("rgba(148,163,184,0.35)");
  });

  it("低分（<60）：暖色警示（红/橙通道显著高于蓝通道）", () => {
    for (const score of [0, 30, 59]) {
      const { r, b } = channelsOf(nodeColorOf(score));
      expect(r).toBeGreaterThan(b);
    }
  });

  it("高分（≥80）：主色实蓝（蓝通道主导）", () => {
    expect(nodeColorOf(100)).toBe("rgba(37,99,235,1)");
    const { b, r } = channelsOf(nodeColorOf(85));
    expect(b).toBeGreaterThan(r);
  });

  it("中分（60~80）：过渡蓝（蓝通道主导，越近 80 越深）", () => {
    expect(nodeColorOf(60)).toBe("rgba(147,197,253,0.9)");
    const mid = channelsOf(nodeColorOf(70));
    expect(mid.b).toBeGreaterThan(mid.r);
    // 70 比 60 更靠近实蓝（红通道更低）
    expect(mid.r).toBeLessThan(channelsOf(nodeColorOf(60)).r);
  });

  it("分档边界：59 暖色、60 蓝色", () => {
    expect(channelsOf(nodeColorOf(59)).r).toBeGreaterThan(channelsOf(nodeColorOf(59)).b);
    expect(channelsOf(nodeColorOf(60)).b).toBeGreaterThan(channelsOf(nodeColorOf(60)).r);
  });

  it("分数越高越不透明（实色）", () => {
    expect(channelsOf(nodeColorOf(90)).alpha).toBeGreaterThan(channelsOf(nodeColorOf(20)).alpha);
  });

  it("越界与非法分数按边界收敛，不抛错", () => {
    expect(nodeColorOf(-5)).toBe(nodeColorOf(0));
    expect(nodeColorOf(120)).toBe(nodeColorOf(100));
    expect(channelsOf(nodeColorOf(Number.NaN)).r).toBeGreaterThan(0);
  });
});

describe("linkRadiusOf：锥形连线单端半径（分数归一化，T18 交付项 6）", () => {
  it("0 分最小、100 分最大、中间线性插值", () => {
    expect(linkRadiusOf(0)).toBe(LINK_RADIUS_MIN);
    expect(linkRadiusOf(100)).toBe(LINK_RADIUS_MAX);
    // round2 后中点有 0.005 量级的取整偏差，精度按 1 位小数断言
    expect(linkRadiusOf(50)).toBeCloseTo((LINK_RADIUS_MIN + LINK_RADIUS_MAX) / 2, 1);
  });

  it("分数越高半径越大（单调递增），粗细差异明显但不喧宾夺主", () => {
    expect(linkRadiusOf(80)).toBeGreaterThan(linkRadiusOf(40));
    // 高分端约为低分端数倍粗，但仍远小于节点球体半径（约 6~9）
    expect(LINK_RADIUS_MAX).toBeGreaterThan(LINK_RADIUS_MIN * 3);
    expect(LINK_RADIUS_MAX).toBeLessThan(NODE_SIZE_MIN);
  });

  it("越界与非法分数按边界收敛，不抛错", () => {
    expect(linkRadiusOf(-5)).toBe(LINK_RADIUS_MIN);
    expect(linkRadiusOf(120)).toBe(LINK_RADIUS_MAX);
    expect(linkRadiusOf(Number.NaN)).toBe(LINK_RADIUS_MIN);
  });
});

describe("linkOf：锥形渐变粗细（两端半径各由该端分数决定）", () => {
  it("高分端半径 > 低分端半径（两端各自独立映射）", () => {
    const link = linkOf(observed("甲", 90), observed("乙", 40));
    expect(link.sourceRadius).toBe(linkRadiusOf(90));
    expect(link.targetRadius).toBe(linkRadiusOf(40));
    expect(link.sourceRadius).toBeGreaterThan(link.targetRadius);
    // 交换 source/target 后半径随端走
    const swapped = linkOf(observed("甲", 40), observed("乙", 90));
    expect(swapped.sourceRadius).toBe(linkRadiusOf(40));
    expect(swapped.targetRadius).toBe(linkRadiusOf(90));
  });

  it("0 分端最细、100 分端最粗（归一化边界）", () => {
    const link = linkOf(observed("甲", 0), observed("乙", 100));
    expect(link.sourceRadius).toBe(LINK_RADIUS_MIN);
    expect(link.targetRadius).toBe(LINK_RADIUS_MAX);
  });

  it("任一端未观测：两端最小半径虚态（faint 规则不变）", () => {
    const faint = linkOf(dim("甲"), observed("乙", 90));
    expect(faint.sourceRadius).toBe(LINK_RADIUS_UNOBSERVED);
    expect(faint.targetRadius).toBe(LINK_RADIUS_UNOBSERVED);
    expect(faint.faint).toBe(true);
    expect(faint.color).toBe("rgba(148,163,184,0.22)");
    expect(linkOf(observed("甲", 90), dim("乙")).faint).toBe(true);
    expect(linkOf(dim("甲"), dim("乙")).faint).toBe(true);
    expect(linkOf(observed("甲", 50), observed("乙", 60)).faint).toBe(false);
    // 未观测端半径恒小于任何已观测端
    expect(LINK_RADIUS_UNOBSERVED).toBeLessThan(LINK_RADIUS_MIN);
  });
});

describe("图例色（T18 交付项 6）：与节点分档端点一致，不漂移", () => {
  const hexOf = (color: string) => {
    const match = color.match(/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/);
    if (!match) throw new Error(`非 rgba 颜色：${color}`);
    return `#${[match[1], match[2], match[3]]
      .map((c) => Number(c).toString(16).padStart(2, "0"))
      .join("")}`.toUpperCase();
  };

  it("较强=100 分实蓝、一般=60 分淡蓝、未观测=灰态本色", () => {
    expect(hexOf(nodeColorOf(100))).toBe(LEGEND_COLOR_STRONG);
    expect(hexOf(nodeColorOf(60))).toBe(LEGEND_COLOR_MID);
    expect(LEGEND_COLOR_UNOBSERVED).toBe("#94A3B8");
  });

  it("较弱=警示带高端琥珀（60 分边界的暖色端点）", () => {
    expect(hexOf(nodeColorOf(59.999))).toBe(LEGEND_COLOR_WARN);
  });
});

describe("nodePositionOf：固定环形布局（T18 固定大小重设计）", () => {
  it("xy 平面半径恒定（所有节点到原点距离 = NETWORK_RING_RADIUS）", () => {
    for (let i = 0; i < 8; i += 1) {
      const { x, y } = nodePositionOf(i, 8);
      // 坐标保留两位小数，hypot 误差在 0.01 量级内
      expect(Math.hypot(x, y)).toBeCloseTo(NETWORK_RING_RADIUS, 1);
    }
  });

  it("角度均匀分布：相邻节点角差 = 2π/total，首节点在 +x 轴", () => {
    const first = nodePositionOf(0, 8);
    expect(first).toMatchObject({ x: NETWORK_RING_RADIUS, y: 0, z: -15 });
    const angles = Array.from({ length: 8 }, (_, i) => {
      const { x, y } = nodePositionOf(i, 8);
      return Math.atan2(y, x);
    });
    for (let i = 1; i < 8; i += 1) {
      // atan2 在 ±π 处环绕，归一化到 [0, 2π) 再比较
      const diff = ((angles[i] - angles[i - 1]) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      expect(diff).toBeCloseTo((2 * Math.PI) / 8, 2);
    }
  });

  it("z 轴按索引确定性交错（-15/-5/+5/+15 循环）", () => {
    expect(Array.from({ length: 8 }, (_, i) => nodePositionOf(i, 8).z)).toEqual([
      -15, -5, 5, 15, -15, -5, 5, 15,
    ]);
  });

  it("无随机性：同 index/total 多次调用结果一致；total 不同角度随之变化", () => {
    expect(nodePositionOf(3, 8)).toEqual(nodePositionOf(3, 8));
    expect(nodePositionOf(1, 4)).toMatchObject({ x: 0, y: NETWORK_RING_RADIUS });
  });
});

describe("buildNetworkGraph：8 维全连接网络图", () => {
  it("全部未观测：8 节点灰态 + 28 边全最细虚态，不报错", () => {
    const graph = buildNetworkGraph(DIMENSION_ORDER.map((d) => dim(d)));
    expect(graph.nodes).toHaveLength(8);
    expect(graph.links).toHaveLength(28);
    for (const node of graph.nodes) {
      expect(node.observed).toBe(false);
      expect(node.size).toBe(NODE_SIZE_MIN);
      expect(node.color).toBe("rgba(148,163,184,0.35)");
    }
    for (const link of graph.links) {
      expect(link.sourceRadius).toBe(LINK_RADIUS_UNOBSERVED);
      expect(link.targetRadius).toBe(LINK_RADIUS_UNOBSERVED);
      expect(link.faint).toBe(true);
    }
  });

  it("28 边覆盖全部节点对且无重复无自连", () => {
    const graph = buildNetworkGraph(DIMENSION_ORDER.map((d) => observed(d, 60)));
    const pairs = new Set(graph.links.map((l) => `${l.source}|${l.target}`));
    expect(pairs.size).toBe(28);
    for (const link of graph.links) {
      expect(link.source).not.toBe(link.target);
    }
    // 每个节点出现在 7 条边上
    for (const d of DIMENSION_ORDER) {
      const degree = graph.links.filter((l) => l.source === d || l.target === d).length;
      expect(degree).toBe(7);
    }
  });

  it("节点 id/标签为维度名，顺序与输入一致；分数写入节点", () => {
    const dims = DIMENSION_ORDER.map((d, i) => observed(d, 10 * (i + 1)));
    const graph = buildNetworkGraph(dims);
    expect(graph.nodes.map((n) => n.id)).toEqual(DIMENSION_ORDER);
    expect(graph.nodes[0]).toMatchObject({ id: "问题定义", score: 10, observed: true });
    // 分数越高节点越大
    expect(graph.nodes[7].size).toBeGreaterThan(graph.nodes[0].size);
  });

  it("节点坐标全部钉住：fx/fy/fz 来自 nodePositionOf 的固定环形布局", () => {
    const graph = buildNetworkGraph(DIMENSION_ORDER.map((d) => observed(d, 60)));
    graph.nodes.forEach((node, i) => {
      const { x, y, z } = nodePositionOf(i, 8);
      expect(node.fx).toBe(x);
      expect(node.fy).toBe(y);
      expect(node.fz).toBe(z);
      expect(Math.hypot(node.fx, node.fy)).toBeCloseTo(NETWORK_RING_RADIUS, 1);
    });
  });
});
