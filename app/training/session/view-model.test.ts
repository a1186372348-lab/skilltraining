import { describe, expect, it } from "vitest";

import type { FollowupRound } from "./contract";
import {
  FOLLOWUP_GENERATING_WINDOW_MS,
  MAX_HINT_LAYERS,
  THINKING_DIRECTIONS,
  buildFollowupMessages,
  canSubmitAnswer,
  coefficientForHintCount,
  followupEmptyState,
  followupFailureMode,
  followupInputPlaceholder,
  formatCoefficient,
  hintMicrocopy,
  isFollowupInputVisible,
  isHintButtonVisible,
  stageLabel,
  stageOfSession,
  toCaseFieldViews,
  toCaseSourceViews,
  toMaterialViews,
} from "./view-model";

// 视图模型纯函数测试（T05-Page）：系数展示（BR-2/D12）、提示按钮显隐（D7）、阶段渲染分支
describe("独立完成系数（BR-2）", () => {
  it("按 max(0.6, 1 − 0.1 × n) 计算，对照表 0~4 次", () => {
    expect(coefficientForHintCount(0)).toBe(1);
    expect(coefficientForHintCount(1)).toBeCloseTo(0.9);
    expect(coefficientForHintCount(2)).toBeCloseTo(0.8);
    expect(coefficientForHintCount(3)).toBeCloseTo(0.7);
    expect(coefficientForHintCount(4)).toBeCloseTo(0.6);
  });

  it("4 次以上封底 0.6（含超出 5 层的异常输入）", () => {
    expect(coefficientForHintCount(5)).toBeCloseTo(0.6);
    expect(coefficientForHintCount(12)).toBeCloseTo(0.6);
  });

  it("非法输入（负数/NaN）按 0 次处理，系数 1.0", () => {
    expect(coefficientForHintCount(-3)).toBe(1);
    expect(coefficientForHintCount(Number.NaN)).toBe(1);
  });
});

describe("系数展示文案（D12）", () => {
  it("格式化为 ×X.X，规避浮点误差", () => {
    expect(formatCoefficient(1)).toBe("×1.0");
    expect(formatCoefficient(0.9)).toBe("×0.9");
    // 1 − 0.1 × 3 的浮点原值
    expect(formatCoefficient(0.7000000000000001)).toBe("×0.7");
    expect(formatCoefficient(0.6)).toBe("×0.6");
    expect(formatCoefficient(Number.NaN)).toBe("×1.0");
  });

  it("提示按钮小字：0 次时强调完全独立，之后只显示当前系数（以服务端系数为准）", () => {
    expect(hintMicrocopy(1, 0)).toBe("当前 ×1.0 · 完全独立");
    expect(hintMicrocopy(0.9, 1)).toBe("当前 ×0.9");
    expect(hintMicrocopy(0.6, 4)).toBe("当前 ×0.6");
  });
});

describe("会话状态 → 页面阶段（刷新恢复渲染分支）", () => {
  it("reading/answering 归为作答阶段，followup 为追问阶段", () => {
    expect(stageOfSession("reading", null)).toBe("answering");
    expect(stageOfSession("answering", null)).toBe("answering");
    expect(stageOfSession("followup", null)).toBe("followup");
  });

  it("scored 为完成阶段", () => {
    expect(stageOfSession("scored", null)).toBe("done");
    expect(stageOfSession("scored", "终答")).toBe("done");
  });

  it("终答已提交但状态未推进（T05 行为：scored 由 T06 写入）也归为完成阶段", () => {
    expect(stageOfSession("followup", "我的最终答案")).toBe("done");
  });

  it("终答为空白串时仍按状态判定（防御异常数据）", () => {
    expect(stageOfSession("followup", "   ")).toBe("followup");
  });

  it("阶段标签文案", () => {
    expect(stageLabel("answering")).toBe("作答中");
    expect(stageLabel("followup")).toBe("追问中");
    expect(stageLabel("done")).toBe("已完成");
  });
});

describe("提示按钮显隐（D7 / BR-3）", () => {
  it("作答阶段且未满 5 层时可见（无服务端标记时本地判定）", () => {
    expect(isHintButtonVisible("answering", 0)).toBe(true);
    expect(isHintButtonVisible("answering", MAX_HINT_LAYERS - 1)).toBe(true);
  });

  it("5 层全部释放后隐藏", () => {
    expect(isHintButtonVisible("answering", MAX_HINT_LAYERS)).toBe(false);
  });

  it("首次提交后（追问/完成阶段）永久消失，与提示次数无关", () => {
    expect(isHintButtonVisible("followup", 0)).toBe(false);
    expect(isHintButtonVisible("followup", 2, true)).toBe(false);
    expect(isHintButtonVisible("done", 0)).toBe(false);
  });

  it("作答阶段优先采用服务端 canRequestHint 权威值", () => {
    expect(isHintButtonVisible("answering", 0, true)).toBe(true);
    expect(isHintButtonVisible("answering", 0, false)).toBe(false);
    expect(isHintButtonVisible("answering", MAX_HINT_LAYERS, true)).toBe(true);
  });
});

describe("答案可提交校验", () => {
  it("空白内容不可提交", () => {
    expect(canSubmitAnswer("")).toBe(false);
    expect(canSubmitAnswer("   \n\t ")).toBe(false);
  });

  it("有实质内容可提交", () => {
    expect(canSubmitAnswer("Agent 接管了任务闭环")).toBe(true);
  });
});

describe("追问对话气泡组装", () => {
  const followups: FollowupRound[] = [
    { round: 1, question: "如果自主操作带来更高的错误风险，这个结论还成立吗？" },
    { round: 2, question: "你提到审查负担，能举一个具体的场景吗？" },
  ];

  it("未提交首答时不产生任何气泡", () => {
    expect(buildFollowupMessages(null, followups)).toEqual([]);
  });

  it("首答渲染为用户右气泡，每轮追问渲染为总监左气泡并带追问标记", () => {
    const messages = buildFollowupMessages("我的首答", followups);
    expect(messages).toEqual([
      { role: "user", content: "我的首答", isFollowup: false },
      {
        role: "director",
        content: "如果自主操作带来更高的错误风险，这个结论还成立吗？",
        isFollowup: true,
      },
      {
        role: "director",
        content: "你提到审查负担，能举一个具体的场景吗？",
        isFollowup: true,
      },
    ]);
  });

  it("AI 追问生成失败（空数组）时只保留首答气泡，可直达终答", () => {
    const messages = buildFollowupMessages("我的首答", []);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });

  it("首答为空白串时视为未提交（防御异常数据）", () => {
    expect(buildFollowupMessages("   ", followups)).toEqual([]);
  });
});

describe("参考资料视图（★核心 2 / ○扩展 3）", () => {
  it("核心在前、扩展在后，徽标正确且保留摘要与链接", () => {
    const views = toMaterialViews({
      core: [
        { title: "核心一", source: "官方博客", url: "https://a.example.com", summary: "摘要一" },
        { title: "核心二", source: "官网", url: "https://b.example.com", summary: "摘要二" },
      ],
      extended: [
        { title: "扩展一", source: "知乎", url: "https://c.example.com", summary: "摘要三" },
      ],
    });
    expect(views.map((v) => v.badge)).toEqual(["★核心", "★核心", "○扩展"]);
    expect(views.map((v) => v.kind)).toEqual(["core", "core", "extended"]);
    expect(views[0]).toMatchObject({
      title: "核心一",
      url: "https://a.example.com",
      summary: "摘要一",
    });
  });
});

describe("思考方向提示（非强制）", () => {
  it("固定五个方向：用户任务 · 当前问题 · 新价值 · 成本 · 风险", () => {
    expect(THINKING_DIRECTIONS).toEqual([
      "用户任务",
      "当前问题",
      "新价值",
      "成本",
      "风险",
    ]);
  });
});

describe("追问为空时的状态判定（T22 / D25：生成中/失败分离）", () => {
  const now = Date.parse("2026-10-07T12:00:00.000Z");

  it("窗口常量：首答提交后 120 秒", () => {
    expect(FOLLOWUP_GENERATING_WINDOW_MS).toBe(120_000);
  });

  it("firstSubmittedAt 为 null：按失败兜底（数据异常）", () => {
    expect(followupEmptyState(null, now)).toBe("failed");
  });

  it("首答提交后 120 秒窗口内：生成中", () => {
    expect(followupEmptyState("2026-10-07T11:59:30.000Z", now)).toBe("generating"); // 30 秒前
    expect(followupEmptyState("2026-10-07T12:00:00.000Z", now)).toBe("generating"); // 刚好提交
    expect(followupEmptyState("2026-10-07T11:58:01.000Z", now)).toBe("generating"); // 窗口内 1 秒
  });

  it("恰过窗口（≥120 秒）：失败", () => {
    expect(followupEmptyState("2026-10-07T11:58:00.000Z", now)).toBe("failed"); // 恰好 120 秒
    expect(followupEmptyState("2026-10-07T11:00:00.000Z", now)).toBe("failed"); // 远超窗口
  });

  it("非法日期字符串：按失败兜底", () => {
    expect(followupEmptyState("不是日期", now)).toBe("failed");
    expect(followupEmptyState("", now)).toBe("failed");
  });
});

describe("案例事实引用视图（T13 / BR-8：字段结尾内联引用链接）", () => {
  const sources = [
    { id: 1, title: "来源一", publisher: "官方博客", url: "https://example.com/a" },
    { id: 2, title: "来源二", publisher: "权威媒体", url: "https://example.com/b" },
  ];

  describe("toCaseSourceViews：case_sources 防御解析", () => {
    it("合法数组原样解析为来源列表", () => {
      expect(toCaseSourceViews(sources)).toEqual(sources);
    });

    it("非数组输入返回空列表", () => {
      expect(toCaseSourceViews(undefined)).toEqual([]);
      expect(toCaseSourceViews(null)).toEqual([]);
      expect(toCaseSourceViews("不是数组")).toEqual([]);
    });

    it("缺字段或非对象条目被丢弃", () => {
      const views = toCaseSourceViews([
        { id: 1, title: "来源一", publisher: "官方", url: "https://example.com/a" },
        { id: 2, title: "缺 publisher", url: "https://example.com/b" },
        "不是对象",
        { id: "3", title: "id 非数字", publisher: "x", url: "https://example.com/c" },
      ]);
      expect(views).toEqual([
        { id: 1, title: "来源一", publisher: "官方", url: "https://example.com/a" },
      ]);
    });
  });

  describe("toCaseFieldViews：五字段 + 内联引用链接视图", () => {
    it("新结构：五字段按固定顺序解析，多引用生成「原文N」内联链接（保持声明顺序）", () => {
      const views = toCaseFieldViews(
        {
          product: { text: "产品介绍。", citations: [1, 2] },
          audience: { text: "目标用户。", citations: [1] },
          scenario: { text: "典型场景。", citations: [2] },
          features: { text: "相关功能。", citations: [2, 1] },
          status: { text: "当前状态。", citations: [1] },
        },
        sources,
      );
      expect(views.map((v) => [v.key, v.label])).toEqual([
        ["product", "产品"],
        ["audience", "服务谁"],
        ["scenario", "场景"],
        ["features", "相关功能"],
        ["status", "当前状态"],
      ]);
      expect(views[0].text).toBe("产品介绍。");
      expect(views[0].citations).toEqual([
        { label: "原文1", url: "https://example.com/a", title: "来源一 · 官方博客" },
        { label: "原文2", url: "https://example.com/b", title: "来源二 · 权威媒体" },
      ]);
      // 单引用显示「原文」
      expect(views[1].citations).toEqual([
        { label: "原文", url: "https://example.com/a", title: "来源一 · 官方博客" },
      ]);
      // citations 顺序按题目声明保留（不按 id 排序），编号随声明顺序
      expect(views[3].citations).toEqual([
        { label: "原文1", url: "https://example.com/b", title: "来源二 · 权威媒体" },
        { label: "原文2", url: "https://example.com/a", title: "来源一 · 官方博客" },
      ]);
    });

    it("引用 id 在来源列表中不存在时该标号被丢弃（防御脏数据）", () => {
      const views = toCaseFieldViews(
        { product: { text: "x", citations: [1, 9] } },
        sources,
      );
      // 悬空 id 丢弃后仅剩一条，按单引用形态显示「原文」
      expect(views[0].citations).toEqual([
        { label: "原文", url: "https://example.com/a", title: "来源一 · 官方博客" },
      ]);
    });

    it("向后兼容：旧版字符串字段（含 related_features / current_status 旧键）原样保留、无引用", () => {
      const views = toCaseFieldViews(
        {
          product: "旧版纯字符串",
          audience: "旧人群",
          scenario: "旧场景",
          related_features: "旧功能",
          current_status: "旧状态",
        },
        [],
      );
      expect(views).toHaveLength(5);
      expect(views.map((v) => v.text)).toEqual([
        "旧版纯字符串",
        "旧人群",
        "旧场景",
        "旧功能",
        "旧状态",
      ]);
      expect(views.every((v) => v.citations.length === 0)).toBe(true);
    });

    it("混态：新键缺失时回退旧键，新键优先", () => {
      const views = toCaseFieldViews(
        {
          product: { text: "新产品", citations: [1] },
          related_features: "旧功能",
        },
        sources,
      );
      expect(views).toHaveLength(2);
      expect(views[0]).toMatchObject({ key: "product", text: "新产品" });
      expect(views[1]).toMatchObject({ key: "features", label: "相关功能", text: "旧功能" });
      expect(views[1].citations).toEqual([]);
    });

    it("脏数据防御：非对象返回空，非法字段值跳过", () => {
      expect(toCaseFieldViews(null, sources)).toEqual([]);
      expect(toCaseFieldViews("x", sources)).toEqual([]);
      const views = toCaseFieldViews(
        { product: { text: "ok", citations: [1] }, scenario: 7, audience: { citations: [1] } },
        sources,
      );
      expect(views.map((v) => v.key)).toEqual(["product"]);
    });

    it("标签可通过参数覆盖（历史详情页复用同一解析、保留各自文案）", () => {
      const views = toCaseFieldViews(
        { audience: { text: "某人群", citations: [1] }, scenario: { text: "某场景", citations: [2] } },
        sources,
        { audience: "服务对象", scenario: "典型场景" },
      );
      expect(views.map((v) => v.label)).toEqual(["服务对象", "典型场景"]);
    });
  });
});

describe("追问失败态渲染判定（T37 / D39：隐藏输入区 + 重试/跳过出口）", () => {
  it("有总监消息（追问非空）时始终为 none，与 emptyState/skipped 无关", () => {
    expect(followupFailureMode(true, null, false)).toBe("none");
    expect(followupFailureMode(true, "generating", false)).toBe("none");
    expect(followupFailureMode(true, "failed", true)).toBe("none");
  });

  it("追问为空但仍在生成中：none（等待卡，不按失败处理）", () => {
    expect(followupFailureMode(false, "generating", false)).toBe("none");
  });

  it("追问为空且非失败态（null）：none", () => {
    expect(followupFailureMode(false, null, false)).toBe("none");
  });

  it("失败态未跳过：failed（隐藏输入区，渲染重试/跳过出口）", () => {
    expect(followupFailureMode(false, "failed", false)).toBe("failed");
  });

  it("失败态已跳过：skipped（恢复输入区，直接作答终案）", () => {
    expect(followupFailureMode(false, "failed", true)).toBe("skipped");
  });

  it("输入区显隐：仅 failed 态隐藏，none/skipped 均显示", () => {
    expect(isFollowupInputVisible("failed")).toBe(false);
    expect(isFollowupInputVisible("none")).toBe(true);
    expect(isFollowupInputVisible("skipped")).toBe(true);
  });

  it("输入框占位文案：skipped 引导直接作答终案，其余为回应追问", () => {
    expect(followupInputPlaceholder("skipped")).toContain("最终");
    expect(followupInputPlaceholder("none")).toBe("回应追问，修正或深化你的结论……");
    expect(followupInputPlaceholder("failed")).toBe("回应追问，修正或深化你的结论……");
  });
});
