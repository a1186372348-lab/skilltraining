import { describe, expect, it } from "vitest";

import {
  MISSING_BADGE_TEXT,
  answerTimeText,
  caseBackgroundRows,
  caseSourceRows,
  coefficientCaption,
  formatDateTime,
  hintEventLine,
  hintSummaryText,
  isSectionMissing,
} from "./view-model";

// 历史详情页视图模型纯函数测试（T10 / US-009 / FR-9）：
// 时间格式化、提示使用回放（层数+时间）、案例背景行解析、缺失分区的标记展示。

describe("时间格式化", () => {
  it("ISO 时间 → 本地 YYYY-MM-DD HH:mm（经本地时区往返构造，与展示口径一致）", () => {
    const iso = new Date(2026, 9, 3, 14, 32).toISOString();
    expect(formatDateTime(iso)).toBe("2026-10-03 14:32");
    const midnight = new Date(2026, 0, 5, 0, 5).toISOString();
    expect(formatDateTime(midnight)).toBe("2026-01-05 00:05");
  });

  it("null / 非法时间显示占位文案", () => {
    expect(formatDateTime(null)).toBe("时间缺失");
    expect(formatDateTime("not-a-date")).toBe("时间缺失");
  });
});

describe("提示使用回放（层数 + 时间）", () => {
  it("单层提示事件行：第 N 层 · 时间", () => {
    const iso = new Date(2026, 9, 3, 14, 32).toISOString();
    expect(hintEventLine({ layer: 2, requestedAt: iso })).toBe(
      "第 2 层提示 · 2026-10-03 14:32",
    );
  });

  it("用量摘要：0 层强调完全独立，N 层说明首次提交前用量", () => {
    expect(hintSummaryText(0)).toBe("完全独立作答，未使用任何提示");
    expect(hintSummaryText(3)).toBe("首次提交前使用了 3 层提示");
  });

  it("系数说明（BR-2 对照：0 次=1.0，2 次=0.8，≥4 次=0.6）", () => {
    expect(coefficientCaption(0)).toBe("独立完成系数 ×1.0");
    expect(coefficientCaption(2)).toBe("独立完成系数 ×0.8");
    expect(coefficientCaption(5)).toBe("独立完成系数 ×0.6");
  });
});

describe("案例背景行解析（产品/服务对象/典型场景/相关功能/当前状态）", () => {
  it("旧版字符串结构：五行按固定顺序解析，无引用标号（向后兼容归档会话）", () => {
    const rows = caseBackgroundRows({
      product: "Cursor",
      audience: "开发者",
      scenario: "编码任务",
      related_features: "Agent 模式",
      current_status: "2.0 多 Agent",
    });
    expect(rows).toEqual([
      { label: "产品", value: "Cursor", citations: [] },
      { label: "服务对象", value: "开发者", citations: [] },
      { label: "典型场景", value: "编码任务", citations: [] },
      { label: "相关功能", value: "Agent 模式", citations: [] },
      { label: "当前状态", value: "2.0 多 Agent", citations: [] },
    ]);
  });

  it("脏数据防御：非对象返回空，非法字段值跳过", () => {
    expect(caseBackgroundRows(null)).toEqual([]);
    expect(caseBackgroundRows("x")).toEqual([]);
    expect(caseBackgroundRows({ product: "P", scenario: 7 })).toEqual([
      { label: "产品", value: "P", citations: [] },
    ]);
  });

  it("新结构（T13 / BR-8）：五字段带引用，解析为字段结尾内联链接视图", () => {
    const rows = caseBackgroundRows({
      product: { text: "产品介绍。", citations: [1, 2] },
      audience: { text: "某人群。", citations: [1] },
      scenario: { text: "某场景。", citations: [2] },
      features: { text: "某功能。", citations: [2, 1] },
      status: { text: "某状态。", citations: [1] },
      case_sources: [
        { id: 1, title: "来源一", publisher: "官方博客", url: "https://example.com/a" },
        { id: 2, title: "来源二", publisher: "权威媒体", url: "https://example.com/b" },
      ],
    });
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ["产品", "产品介绍。"],
      ["服务对象", "某人群。"],
      ["典型场景", "某场景。"],
      ["相关功能", "某功能。"],
      ["当前状态", "某状态。"],
    ]);
    expect(rows[0].citations).toEqual([
      { label: "原文1", url: "https://example.com/a", title: "来源一 · 官方博客" },
      { label: "原文2", url: "https://example.com/b", title: "来源二 · 权威媒体" },
    ]);
    // 单引用显示「原文」
    expect(rows[1].citations).toEqual([
      { label: "原文", url: "https://example.com/a", title: "来源一 · 官方博客" },
    ]);
    // citations 顺序按题目声明保留
    expect(rows[3].citations.map((c) => c.url)).toEqual([
      "https://example.com/b",
      "https://example.com/a",
    ]);
  });

  it("新结构：引用 id 不在内嵌 case_sources 中时该标号被丢弃", () => {
    const rows = caseBackgroundRows({
      product: { text: "x", citations: [1, 9] },
      case_sources: [{ id: 1, title: "来源一", publisher: "官方", url: "https://example.com/a" }],
    });
    expect(rows[0].citations).toEqual([
      { label: "原文", url: "https://example.com/a", title: "来源一 · 官方" },
    ]);
  });
});

describe("案例来源列表（T13 / BR-8：从内嵌 case_sources 键提取）", () => {
  it("提取案例背景 jsonb 内嵌的来源列表", () => {
    const sources = caseSourceRows({
      product: { text: "x", citations: [1] },
      case_sources: [
        { id: 1, title: "来源一", publisher: "官方博客", url: "https://example.com/a" },
        { id: 2, title: "来源二", publisher: "权威媒体", url: "https://example.com/b" },
      ],
    });
    expect(sources).toEqual([
      { id: 1, title: "来源一", publisher: "官方博客", url: "https://example.com/a" },
      { id: 2, title: "来源二", publisher: "权威媒体", url: "https://example.com/b" },
    ]);
  });

  it("无 case_sources 键或非对象输入返回空（旧版会话兼容）", () => {
    expect(caseSourceRows({ product: "旧版" })).toEqual([]);
    expect(caseSourceRows(null)).toEqual([]);
    expect(caseSourceRows({ case_sources: "不是数组" })).toEqual([]);
  });
});

describe("缺失分区标记（任务契约：标记而非报错）", () => {
  it("按 missing 列表判定分区是否缺失", () => {
    expect(isSectionMissing(["feedback"], "feedback")).toBe(true);
    expect(isSectionMissing(["feedback"], "scores")).toBe(false);
    expect(isSectionMissing([], "firstAnswer")).toBe(false);
  });

  it("缺失徽标文案", () => {
    expect(MISSING_BADGE_TEXT).toBe("记录缺失");
  });
});

describe("答案提交时间小字", () => {
  it("已提交：提交于 + 时间；未提交：占位文案", () => {
    const iso = new Date(2026, 9, 3, 14, 32).toISOString();
    expect(answerTimeText(iso)).toBe("提交于 2026-10-03 14:32");
    expect(answerTimeText(null)).toBe("未提交");
  });
});
