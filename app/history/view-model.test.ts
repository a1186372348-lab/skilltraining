import { describe, expect, it } from "vitest";

import type { HistoryPagination, HistoryScoreSummary } from "./contract";
import {
  HISTORY_PAGE_SIZE,
  formatHistoryDate,
  hasNextPage,
  hasPrevPage,
  paginationInfoText,
  scoreSummaryText,
  sessionStateText,
  trainingCountText,
} from "./view-model";

// 历史列表页视图模型纯函数测试（T10 / US-009）：
// 日期格式化、状态文案、有效分摘要、分页判定与分页文案、空态文案。

function pagination(overrides: Partial<HistoryPagination> = {}): HistoryPagination {
  return { page: 1, pageSize: 10, total: 0, totalPages: 0, ...overrides };
}

describe("日期与状态文案", () => {
  it("ISO 日期格式化为中文日期", () => {
    expect(formatHistoryDate("2026-10-03")).toBe("2026年10月3日");
    expect(formatHistoryDate("2026-01-15")).toBe("2026年1月15日");
  });

  it("非法输入原样返回（防御脏数据）", () => {
    expect(formatHistoryDate("")).toBe("");
    expect(formatHistoryDate("20261003")).toBe("20261003");
  });

  it("会话状态 → 状态标签", () => {
    expect(sessionStateText("reading")).toBe("进行中");
    expect(sessionStateText("answering")).toBe("作答中");
    expect(sessionStateText("followup")).toBe("追问中");
    expect(sessionStateText("scored")).toBe("已完成");
  });
});

describe("有效分摘要（列表卡片小字）", () => {
  it("各维度有效分用 · 连接", () => {
    const scores: HistoryScoreSummary[] = [
      { dimension: "用户理解", effectiveScore: 68 },
      { dimension: "产品价值判断", effectiveScore: 72.5 },
    ];
    expect(scoreSummaryText(scores)).toBe("用户理解 68 · 产品价值判断 72.5");
  });

  it("未评分会话显示占位文案", () => {
    expect(scoreSummaryText([])).toBe("暂无评分");
  });
});

describe("分页判定与文案", () => {
  it("每页条数固定 10", () => {
    expect(HISTORY_PAGE_SIZE).toBe(10);
  });

  it("上一页/下一页判定", () => {
    expect(hasPrevPage(1)).toBe(false);
    expect(hasPrevPage(2)).toBe(true);
    expect(hasNextPage(1, 3)).toBe(true);
    expect(hasNextPage(3, 3)).toBe(false);
    expect(hasNextPage(1, 0)).toBe(false);
  });

  it("分页信息文案：第 N / M 页 · 共 T 次训练", () => {
    expect(paginationInfoText(pagination({ page: 2, total: 25, totalPages: 3 }))).toBe(
      "第 2 / 3 页 · 共 25 次训练",
    );
    expect(paginationInfoText(pagination({ page: 1, total: 1, totalPages: 1 }))).toBe(
      "第 1 / 1 页 · 共 1 次训练",
    );
  });

  it("空态文案：total 为 0 时不显示页码", () => {
    expect(paginationInfoText(pagination())).toBe("暂无训练记录");
  });

  it("侧栏底部计数文案", () => {
    expect(trainingCountText(25)).toBe("共 25 次训练");
    expect(trainingCountText(0)).toBe("暂无训练记录");
  });
});
