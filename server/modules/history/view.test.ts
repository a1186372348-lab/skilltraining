import { describe, expect, it } from "vitest";

import {
  buildPagination,
  computeMissingSections,
  parseAbilityTags,
  toHistoryDetailView,
  toHistoryListItem,
  type HistorySessionDetailRow,
  type HistorySessionListRow,
} from "./view";

// 历史回放装配纯函数测试（T10 / US-009 / FR-9）：
// 列表项映射、分页元数据、详情六区完整性、缺失字段标记（而非报错）、
// FR-10 出口防线（rubric / hintTree 不进入任何历史视图）。

function listRow(overrides: Partial<HistorySessionListRow> = {}): HistorySessionListRow {
  return {
    id: "session-1",
    date: new Date(Date.UTC(2026, 9, 3)),
    isExtra: false,
    state: "scored",
    question: {
      caseTitle: "从「帮你写」到「替你做」：Cursor 的 Agent 模式",
      abilityTags: ["用户理解", "产品价值判断", "产品取舍"],
    },
    scores: [
      { dimension: "用户理解", effectiveScore: 68 },
      { dimension: "产品价值判断", effectiveScore: 72 },
    ],
    ...overrides,
  };
}

function detailRow(overrides: Partial<HistorySessionDetailRow> = {}): HistorySessionDetailRow {
  return {
    id: "session-1",
    userId: "user-1",
    date: new Date(Date.UTC(2026, 9, 3)),
    isExtra: false,
    state: "scored",
    firstAnswer: "首答：Agent 模式是质变，因为它接管了任务闭环。",
    firstSubmittedAt: new Date(Date.UTC(2026, 9, 3, 6, 10)),
    finalAnswer: "终答：补充了用户让渡控制权的代价与验证指标。",
    finalSubmittedAt: new Date(Date.UTC(2026, 9, 3, 6, 40)),
    hintCount: 2,
    followups: [
      { round: 1, question: "如果自主操作带来更高的错误风险，结论还成立吗？" },
      { round: 2, question: "有证据吗？你会看哪个指标？" },
    ],
    question: {
      caseTitle: "从「帮你写」到「替你做」：Cursor 的 Agent 模式",
      caseBackground: {
        product: "Cursor——AI 原生代码编辑器。",
        audience: "软件开发者。",
        scenario: "完成真实编码任务的全过程。",
        related_features: "Tab 补全、Cmd+K、Agent 模式。",
        current_status: "2025 年 Cursor 2.0 转向多 Agent 管理。",
      },
      mainQuestion: "为什么这是产品价值上的质变而不只是功能叠加？",
      abilityTags: ["用户理解", "产品价值判断", "产品取舍"],
      difficulty: 3,
    },
    hintEvents: [
      { layer: 1, requestedAt: new Date(Date.UTC(2026, 9, 3, 6, 1)) },
      { layer: 2, requestedAt: new Date(Date.UTC(2026, 9, 3, 6, 5)) },
    ],
    scores: [
      {
        dimension: "用户理解",
        rawScore: 85,
        hintCount: 2,
        coefficient: 0.8,
        effectiveScore: 68,
        diagnosisText: "对开发者工作流的拆解到位。",
      },
    ],
    feedback: {
      topIssueText: "终答缺少量化指标，应补充衡量口径。",
      nextFocusText: "下一步练「产品价值判断」中的价值量化类问题。",
    },
    ...overrides,
  };
}

describe("能力标签防御解析", () => {
  it("仅保留字符串项，非数组/脏数据回退空数组", () => {
    expect(parseAbilityTags(["用户理解", "产品取舍"])).toEqual(["用户理解", "产品取舍"]);
    expect(parseAbilityTags(["用户理解", 1, null, { tag: "x" }])).toEqual(["用户理解"]);
    expect(parseAbilityTags("用户理解")).toEqual([]);
    expect(parseAbilityTags(null)).toEqual([]);
    expect(parseAbilityTags(undefined)).toEqual([]);
  });
});

describe("分页元数据", () => {
  it("totalPages 向上取整；0 条记录时 totalPages 为 0", () => {
    expect(buildPagination(25, 1, 10)).toEqual({
      page: 1,
      pageSize: 10,
      total: 25,
      totalPages: 3,
    });
    expect(buildPagination(20, 2, 10).totalPages).toBe(2);
    expect(buildPagination(0, 1, 10).totalPages).toBe(0);
    expect(buildPagination(1, 1, 50).totalPages).toBe(1);
  });
});

describe("列表项装配（日期 / 案例名 / 训练重点 / 有效分摘要 / 状态）", () => {
  it("完整映射五个字段，日期取 ISO 前 10 位", () => {
    const item = toHistoryListItem(listRow());
    expect(item).toEqual({
      sessionId: "session-1",
      date: "2026-10-03",
      caseTitle: "从「帮你写」到「替你做」：Cursor 的 Agent 模式",
      abilityTags: ["用户理解", "产品价值判断", "产品取舍"],
      isExtra: false,
      state: "scored",
      scores: [
        { dimension: "用户理解", effectiveScore: 68 },
        { dimension: "产品价值判断", effectiveScore: 72 },
      ],
    });
  });

  it("未评分会话 scores 为空数组；加练标记透传", () => {
    const item = toHistoryListItem(
      listRow({ state: "answering", scores: [], isExtra: true }),
    );
    expect(item.scores).toEqual([]);
    expect(item.isExtra).toBe(true);
  });

  it("能力标签脏数据不报错，仅保留字符串项", () => {
    const item = toHistoryListItem(
      listRow({ question: { caseTitle: "题", abilityTags: ["用户理解", 7] } }),
    );
    expect(item.abilityTags).toEqual(["用户理解"]);
  });
});

describe("详情回放装配完整性（US-009：案例/两版答案/提示/追问/评分/反馈）", () => {
  it("六个分区全部装配，提示含层数与时间，评分为四元组", () => {
    const view = toHistoryDetailView(detailRow());

    // 案例区
    expect(view.caseTitle).toContain("Cursor");
    expect(view.caseBackground).toMatchObject({ product: "Cursor——AI 原生代码编辑器。" });
    expect(view.mainQuestion).toContain("质变");
    expect(view.abilityTags).toEqual(["用户理解", "产品价值判断", "产品取舍"]);
    expect(view.difficulty).toBe(3);

    // 两版答案
    expect(view.firstAnswer).toContain("首答");
    expect(view.firstSubmittedAt).toBe("2026-10-03T06:10:00.000Z");
    expect(view.finalAnswer).toContain("终答");
    expect(view.finalSubmittedAt).toBe("2026-10-03T06:40:00.000Z");

    // 提示使用（层数 + 时间）
    expect(view.hintCount).toBe(2);
    expect(view.hintEvents).toEqual([
      { layer: 1, requestedAt: "2026-10-03T06:01:00.000Z" },
      { layer: 2, requestedAt: "2026-10-03T06:05:00.000Z" },
    ]);

    // 追问对话记录
    expect(view.followups).toEqual([
      { round: 1, question: "如果自主操作带来更高的错误风险，结论还成立吗？" },
      { round: 2, question: "有证据吗？你会看哪个指标？" },
    ]);

    // 评分四元组（D8）
    expect(view.scores).toEqual([
      {
        dimension: "用户理解",
        rawScore: 85,
        hintCount: 2,
        coefficient: 0.8,
        effectiveScore: 68,
        diagnosisText: "对开发者工作流的拆解到位。",
      },
    ]);

    // 反馈（BR-7）
    expect(view.feedback).toEqual({
      topIssueText: "终答缺少量化指标，应补充衡量口径。",
      nextFocusText: "下一步练「产品价值判断」中的价值量化类问题。",
    });

    expect(view.missing).toEqual([]);
    expect(view.date).toBe("2026-10-03");
    expect(view.state).toBe("scored");
  });

  it("FR-10：视图不携带 rubric / hintTree 任何痕迹", () => {
    const view = toHistoryDetailView(detailRow());
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("rubric");
    expect(serialized).not.toContain("hintTree");
    expect(serialized).not.toContain("绝密");
  });

  it("追问记录脏数据防御：非法项被过滤", () => {
    const view = toHistoryDetailView(
      detailRow({ followups: [{ round: 1, question: "有效追问" }, "坏数据", { round: "x" }] }),
    );
    expect(view.followups).toEqual([{ round: 1, question: "有效追问" }]);
  });
});

describe("缺失字段标记（任务契约：标记缺失而非整页报错）", () => {
  it("进行中会话（answering）：无首答/终答/评分/反馈均属正常，不标记缺失", () => {
    const row = detailRow({
      state: "answering",
      firstAnswer: null,
      firstSubmittedAt: null,
      finalAnswer: null,
      finalSubmittedAt: null,
      followups: null,
      scores: [],
      feedback: null,
    });
    expect(computeMissingSections(row)).toEqual([]);
    expect(toHistoryDetailView(row).missing).toEqual([]);
  });

  it("已评分但反馈缺失：标记 feedback，其余分区照常装配", () => {
    const view = toHistoryDetailView(detailRow({ feedback: null }));
    expect(view.missing).toEqual(["feedback"]);
    expect(view.feedback).toBeNull();
    expect(view.scores).toHaveLength(1);
  });

  it("已评分但评分行缺失：同时标记 scores 与 feedback", () => {
    const view = toHistoryDetailView(detailRow({ scores: [], feedback: null }));
    expect(view.missing).toEqual(["scores", "feedback"]);
  });

  it("追问/评分阶段首答丢失：标记 firstAnswer", () => {
    const view = toHistoryDetailView(
      detailRow({ state: "followup", firstAnswer: null, finalAnswer: null, scores: [], feedback: null }),
    );
    expect(view.missing).toEqual(["firstAnswer"]);
  });

  it("已评分但终答丢失：标记 finalAnswer", () => {
    const view = toHistoryDetailView(detailRow({ finalAnswer: null }));
    expect(view.missing).toEqual(["finalAnswer"]);
  });

  it("未使用提示：hintEvents 为空是正常态，不标记缺失", () => {
    const view = toHistoryDetailView(detailRow({ hintCount: 0, hintEvents: [] }));
    expect(view.missing).toEqual([]);
    expect(view.hintEvents).toEqual([]);
  });
});
