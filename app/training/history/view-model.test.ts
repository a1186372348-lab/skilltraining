import { describe, expect, it } from "vitest";

import {
  formatHistoryDate,
  sessionStateText,
} from "./view-model";

// 历史回放共享视图模型纯函数测试（T10 / US-009；T25 起仅保留详情共用函数——
// 列表分页/摘要函数已随旧列表页删除）：日期格式化、状态文案。

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
    // T38 / D40：已终止会话只读回放
    expect(sessionStateText("abandoned")).toBe("已终止");
  });
});
