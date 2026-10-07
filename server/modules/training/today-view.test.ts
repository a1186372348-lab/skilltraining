import type { Question, TrainingSession } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { toTodayView } from "./today-view";

// FR-10 出口防线：today 视图绝不携带 Rubric、未释放提示层与评分 prompt。
// 纯函数单测，不依赖数据库。

function makeQuestion(): Question {
  return {
    id: "q-1",
    caseTitle: "案例标题",
    caseBackground: { product: "某产品", audience: "某人群" },
    mainQuestion: "主问题？",
    abilityTags: ["用户理解", "产品取舍"],
    difficulty: 2,
    rubric: { dimensions: { 用户理解: ["绝密要点"] }, forbidden_leaks: ["绝密结论"] },
    hintTree: [
      { level: 1, stage: "任务澄清", question: "提示1" },
      { level: 2, stage: "视角补充", question: "提示2" },
      { level: 3, stage: "反例", question: "提示3" },
      { level: 4, stage: "取舍", question: "提示4" },
      { level: 5, stage: "验证", question: "提示5" },
    ],
    materials: { core: [{ title: "核心1" }], extended: [{ title: "扩展1" }] },
    status: "published",
  } as unknown as Question;
}

function makeSession(overrides: Partial<TrainingSession> = {}): TrainingSession {
  return {
    id: "s-1",
    userId: "u-1",
    questionId: "q-1",
    date: new Date("2026-10-03T00:00:00Z"),
    isExtra: false,
    state: "reading",
    firstAnswer: null,
    finalAnswer: null,
    hintCount: 0,
    followups: null,
    startedAt: new Date(),
    firstSubmittedAt: null,
    finalSubmittedAt: null,
    scoredAt: null,
    ...overrides,
  } as TrainingSession;
}

describe("toTodayView（FR-10：不下发 Rubric 与未释放提示层）", () => {
  it("初始态：不含 rubric / hintTree 字段，releasedHints 为空，系数 1.0，可请求提示", () => {
    const view = toTodayView(makeSession(), makeQuestion());
    expect(view.sessionId).toBe("s-1");
    expect(view.state).toBe("reading");
    expect(view.coefficient).toBe(1.0);
    expect(view.releasedHints).toEqual([]);
    expect(view.canRequestHint).toBe(true);
    expect(view.caseTitle).toBe("案例标题");
    expect(view.mainQuestion).toBe("主问题？");
    expect(view.abilityTags).toEqual(["用户理解", "产品取舍"]);
    const raw = JSON.stringify(view);
    expect(raw).not.toContain("绝密要点");
    expect(raw).not.toContain("绝密结论");
    expect(raw).not.toContain("rubric");
    expect(raw).not.toContain("hintTree");
    expect(raw).not.toContain("提示2"); // 未释放层不下发
  });

  it("已请求 2 层提示：只下发前 2 层，系数 0.8", () => {
    const view = toTodayView(makeSession({ hintCount: 2, state: "answering" }), makeQuestion());
    expect(view.releasedHints.map((h) => h.level)).toEqual([1, 2]);
    expect(view.coefficient).toBe(0.8);
    expect(JSON.stringify(view)).not.toContain("提示3");
  });

  it("首答后：canRequestHint=false（D7），追问记录可见", () => {
    const view = toTodayView(
      makeSession({
        state: "followup",
        firstAnswer: "我的首答",
        firstSubmittedAt: new Date(),
        followups: [{ round: 1, question: "证据呢？" }],
      }),
      makeQuestion(),
    );
    expect(view.canRequestHint).toBe(false);
    expect(view.firstAnswer).toBe("我的首答");
    // 存量无 hint 的老记录：按无提示容错处理（不回填）
    expect(view.followups).toEqual([
      { round: 1, question: "证据呢？", hasHint: false, hintReleased: false, hint: null },
    ]);
  });

  it("提示用满 5 层：canRequestHint=false，系数 0.6 下限", () => {
    const view = toTodayView(makeSession({ hintCount: 5, state: "answering" }), makeQuestion());
    expect(view.canRequestHint).toBe(false);
    expect(view.coefficient).toBe(0.6);
    expect(view.releasedHints).toHaveLength(5);
  });

  it("下发 firstSubmittedAt（ISO 字符串；T22 追问生成中/失败判定依据），未提交为 null", () => {
    const submittedAt = new Date("2026-10-07T11:58:00.000Z");
    const view = toTodayView(
      makeSession({ state: "followup", firstAnswer: "首答", firstSubmittedAt: submittedAt }),
      makeQuestion(),
    );
    expect(view.firstSubmittedAt).toBe("2026-10-07T11:58:00.000Z");
    expect(toTodayView(makeSession(), makeQuestion()).firstSubmittedAt).toBeNull();
  });
});

describe("追问提示下发契约（T19 / D22 / FR-10）", () => {
  const followupSession = (overrides: Partial<TrainingSession> = {}) =>
    makeSession({
      state: "followup",
      firstAnswer: "首答",
      firstSubmittedAt: new Date(),
      followups: [
        { round: 1, question: "追问一", hint: "绝密追问提示一", hintReleased: false },
        { round: 2, question: "追问二", hint: "绝密追问提示二", hintReleased: true },
      ],
      ...overrides,
    });

  it("未释放的追问提示绝不下发明文；已释放的下发", () => {
    const view = toTodayView(followupSession(), makeQuestion());
    expect(view.followups).toEqual([
      { round: 1, question: "追问一", hasHint: true, hintReleased: false, hint: null },
      { round: 2, question: "追问二", hasHint: true, hintReleased: true, hint: "绝密追问提示二" },
    ]);
    const raw = JSON.stringify(view);
    expect(raw).not.toContain("绝密追问提示一"); // 未释放：明文不出现在视图任何角落
    expect(raw).toContain("绝密追问提示二");
  });

  it("下发 followupHintCount；coefficient 按 BR-2 修订公式（追问提示半价）计算", () => {
    const view = toTodayView(
      followupSession({ hintCount: 1, followupHintCount: 1 } as Partial<TrainingSession>),
      makeQuestion(),
    );
    expect(view.followupHintCount).toBe(1);
    expect(view.coefficient).toBe(0.85); // max(0.6, 1 − 0.1×1 − 0.05×1)
  });

  it("未请求任何追问提示：系数与修订前完全一致（回归）", () => {
    const view = toTodayView(followupSession({ hintCount: 2 } as Partial<TrainingSession>), makeQuestion());
    expect(view.followupHintCount ?? 0).toBe(0);
    expect(view.coefficient).toBe(0.8);
  });

  it("hint 为空串的记录（AI 降级）：hasHint=false，不显示入口", () => {
    const view = toTodayView(
      followupSession({
        followups: [{ round: 1, question: "追问一", hint: "", hintReleased: false }],
      }),
      makeQuestion(),
    );
    expect(view.followups).toEqual([
      { round: 1, question: "追问一", hasHint: false, hintReleased: false, hint: null },
    ]);
  });
});

describe("案例事实引用序列化（T13 / BR-8：case_background 五字段 + case_sources）", () => {
  /** 新结构 jsonb：五字段 {text, citations[]} + 内嵌 case_sources（导入管线落库形状） */
  function makeCitedQuestion(): Question {
    return {
      ...makeQuestion(),
      caseBackground: {
        product: { text: "某产品介绍。", citations: [1, 2] },
        audience: { text: "某人群。", citations: [1] },
        scenario: { text: "某场景。", citations: [2] },
        features: { text: "某功能。", citations: [1, 2] },
        status: { text: "某状态。", citations: [2] },
        case_sources: [
          { id: 1, title: "来源一", publisher: "官方博客", url: "https://example.com/a" },
          { id: 2, title: "来源二", publisher: "权威媒体", url: "https://example.com/b" },
        ],
      },
    } as unknown as Question;
  }

  it("新结构：case_sources 拆为视图独立字段，五字段原样保留", () => {
    const view = toTodayView(makeSession(), makeCitedQuestion());
    expect(view.caseSources).toEqual([
      { id: 1, title: "来源一", publisher: "官方博客", url: "https://example.com/a" },
      { id: 2, title: "来源二", publisher: "权威媒体", url: "https://example.com/b" },
    ]);
    // 五字段区域保留 {text, citations} 结构，内嵌 case_sources 键不重复下发
    const background = view.caseBackground as Record<string, unknown>;
    expect(background.product).toEqual({ text: "某产品介绍。", citations: [1, 2] });
    expect(background.status).toEqual({ text: "某状态。", citations: [2] });
    expect(background).not.toHaveProperty("case_sources");
  });

  it("向后兼容：旧版字符串形字段原样透传，caseSources 为空，不报错", () => {
    const legacy = {
      ...makeQuestion(),
      caseBackground: {
        product: "旧版纯字符串",
        audience: "旧人群",
        scenario: "旧场景",
        related_features: "旧功能",
        current_status: "旧状态",
      },
    } as unknown as Question;
    const view = toTodayView(makeSession(), legacy);
    expect(view.caseSources).toEqual([]);
    expect(view.caseBackground).toEqual({
      product: "旧版纯字符串",
      audience: "旧人群",
      scenario: "旧场景",
      related_features: "旧功能",
      current_status: "旧状态",
    });
  });

  it("uncertainty 等既有内嵌键保持透传（仅拆出 case_sources）", () => {
    const question = {
      ...makeQuestion(),
      caseBackground: {
        product: { text: "x", citations: [1] },
        case_sources: [{ id: 1, title: "t", publisher: "p", url: "https://example.com/a" }],
        uncertainty: ["某数据未官方确认"],
      },
    } as unknown as Question;
    const view = toTodayView(makeSession(), question);
    const background = view.caseBackground as Record<string, unknown>;
    expect(background.uncertainty).toEqual(["某数据未官方确认"]);
    expect(background).not.toHaveProperty("case_sources");
    expect(view.caseSources).toHaveLength(1);
  });

  it("脏数据防御：case_sources 非数组或条目缺字段时过滤，不报错", () => {
    const badShape = {
      ...makeQuestion(),
      caseBackground: { product: "x", case_sources: "不是数组" },
    } as unknown as Question;
    expect(toTodayView(makeSession(), badShape).caseSources).toEqual([]);

    const partial = {
      ...makeQuestion(),
      caseBackground: {
        product: "x",
        case_sources: [
          { id: 1, title: "t", publisher: "p", url: "https://example.com/a" },
          { id: 2, title: "缺 publisher", url: "https://example.com/b" },
          "不是对象",
        ],
      },
    } as unknown as Question;
    expect(toTodayView(makeSession(), partial).caseSources).toEqual([
      { id: 1, title: "t", publisher: "p", url: "https://example.com/a" },
    ]);
  });

  it("caseBackground 非对象（极端脏数据）原样透传，caseSources 为空", () => {
    const question = { ...makeQuestion(), caseBackground: null } as unknown as Question;
    const view = toTodayView(makeSession(), question);
    expect(view.caseBackground).toBeNull();
    expect(view.caseSources).toEqual([]);
  });
});
