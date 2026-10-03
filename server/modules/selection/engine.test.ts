import { describe, expect, it } from "vitest";

import type { AbilityProfileDimensionView } from "@/server/modules/profile/ability";
import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";

import {
  buildCaseText,
  extractCaseProductKey,
  matchesInterestAreas,
  parseAbilityTags,
  RECENT_CASE_WINDOW,
  selectQuestion,
  type CandidateQuestion,
  type SelectionInput,
} from "./engine";

// 自适应出题引擎（Prd.md 图 2 / US-010 / FR-2）纯函数单测。
// 覆盖分支：全未知画像（探索期）、部分观测、强化期最低分维度、高提示依赖优先独立性训练、
// 已练过滤、近期同类案例过滤、全已练放宽、兴趣匹配/无匹配、难度梯度、
// 首次训练熟悉产品优先（D11）、目标维度无题覆盖回退、空池。

function fixtureQuestion(overrides: Partial<CandidateQuestion> & { id: string }): CandidateQuestion {
  return {
    caseTitle: `案例 ${overrides.id}`,
    caseBackground: {
      product: `产品${overrides.id}——测试产品背景。`,
      audience: "测试用户",
      scenario: "测试场景",
      related_features: "测试功能",
      current_status: "测试现状",
    },
    mainQuestion: "测试主问题？",
    abilityTags: ["用户理解", "方案设计"],
    difficulty: 3,
    ...overrides,
  };
}

function profileView(
  observed: Record<string, { score: number; hintDependency?: number | null }>,
): AbilityProfileDimensionView[] {
  return ABILITY_DIMENSIONS.map((dimension) => {
    const hit = observed[dimension];
    if (!hit) {
      return {
        dimension,
        observed: false,
        currentScore: null,
        observationCount: 0,
        hintDependency: null,
        hintDependencyBand: null,
        trend: null,
        updatedAt: null,
      };
    }
    const dep = hit.hintDependency ?? 0;
    return {
      dimension,
      observed: true,
      currentScore: hit.score,
      observationCount: 3,
      hintDependency: dep,
      hintDependencyBand: dep < 1 ? "低" : dep <= 2.5 ? "中" : "高",
      trend: "稳定",
      updatedAt: new Date(Date.UTC(2026, 9, 1)),
    };
  });
}

function baseInput(overrides: Partial<SelectionInput>): SelectionInput {
  return {
    profile: profileView({}),
    familiarProducts: [],
    interestAreas: [],
    questions: [],
    practicedQuestionIds: new Set<string>(),
    recentCaseBackgrounds: [],
    isFirstTraining: false,
    ...overrides,
  };
}

describe("解析辅助函数", () => {
  it("parseAbilityTags：仅接受字符串数组，脏数据归一为空数组", () => {
    expect(parseAbilityTags(["用户理解", "方案设计"])).toEqual(["用户理解", "方案设计"]);
    expect(parseAbilityTags(null)).toEqual([]);
    expect(parseAbilityTags("用户理解")).toEqual([]);
    expect(parseAbilityTags(["用户理解", 1, null])).toEqual(["用户理解"]);
  });

  it("extractCaseProductKey：取 product 字段首个分隔符前的产品名", () => {
    expect(
      extractCaseProductKey({ product: "抖音——字节跳动旗下短视频平台，以视频流为核心。" }),
    ).toBe("抖音");
    expect(extractCaseProductKey({ product: "Notion：一体化工作空间。" })).toBe("Notion");
    expect(extractCaseProductKey({ product: "测试产品" })).toBe("测试产品");
    expect(extractCaseProductKey(null)).toBe("");
    expect(extractCaseProductKey({ audience: "没有 product 字段" })).toBe("");
  });

  it("buildCaseText：拼接案例全部文本字段供关键词匹配", () => {
    const text = buildCaseText(fixtureQuestion({ id: "q1" }));
    expect(text).toContain("案例 q1");
    expect(text).toContain("测试产品背景");
    expect(text).toContain("测试主问题？");
  });

  it("matchesInterestAreas：兴趣词按 / 与空白切分后做子串匹配", () => {
    const text = "抖音的图文种草与电商变现链路";
    expect(matchesInterestAreas(text, ["电商/交易"])).toBe("电商/交易");
    expect(matchesInterestAreas(text, ["出海/国际化"])).toBeNull();
    expect(matchesInterestAreas(text, [])).toBeNull();
  });
});

describe("selectQuestion：阶段判定（图 2）", () => {
  it("全未知画像 → 探索期，优先覆盖未知维度", () => {
    const outcome = selectQuestion(
      baseInput({
        profile: profileView({}),
        questions: [
          fixtureQuestion({ id: "q-a", abilityTags: ["用户理解"] }),
          fixtureQuestion({ id: "q-b", abilityTags: ["根因分析", "指标与验证"] }),
        ],
      }),
    );
    expect(outcome).not.toBeNull();
    expect(outcome!.phase).toBe("exploration");
    // 8 维全未知，两题都覆盖未知维度；q-b 覆盖 2 个未知维度，优先
    expect(outcome!.questionId).toBe("q-b");
    expect(outcome!.reason).toContain("探索期");
    expect(outcome!.reason).toContain("未知维度");
  });

  it("部分观测 → 探索期只瞄准剩余未知维度；覆盖已观测维度的题不优先", () => {
    // 已观测 7 维，仅「产品表达」未知
    const observed: Record<string, { score: number }> = {};
    for (const d of ABILITY_DIMENSIONS) {
      if (d !== "产品表达") observed[d] = { score: 70 };
    }
    const outcome = selectQuestion(
      baseInput({
        profile: profileView(observed),
        questions: [
          fixtureQuestion({ id: "q-known", abilityTags: ["用户理解"] }), // 只覆盖已观测维度
          fixtureQuestion({ id: "q-unknown", abilityTags: ["产品表达"] }),
        ],
      }),
    );
    expect(outcome!.phase).toBe("exploration");
    expect(outcome!.questionId).toBe("q-unknown");
    expect(outcome!.targetDimensions).toEqual(["产品表达"]);
    expect(outcome!.reason).toContain("产品表达");
  });

  it("全部维度已观测 → 强化期，取最低分维度为弱项", () => {
    const observed: Record<string, { score: number }> = {};
    for (const d of ABILITY_DIMENSIONS) observed[d] = { score: 70 };
    observed["根因分析"] = { score: 52 }; // 最低分
    const outcome = selectQuestion(
      baseInput({
        profile: profileView(observed),
        questions: [
          fixtureQuestion({ id: "q-other", abilityTags: ["用户理解"] }),
          fixtureQuestion({ id: "q-weak", abilityTags: ["根因分析", "产品取舍"] }),
        ],
      }),
    );
    expect(outcome!.phase).toBe("strengthening");
    expect(outcome!.questionId).toBe("q-weak");
    expect(outcome!.targetDimensions).toEqual(["根因分析"]);
    expect(outcome!.reason).toContain("强化期");
    expect(outcome!.reason).toContain("根因分析");
    expect(outcome!.reason).toContain("52");
  });
});

describe("selectQuestion：提示依赖特征（BR-5 强化期）", () => {
  const observedAll = (dep: number) => {
    const observed: Record<string, { score: number; hintDependency: number }> = {};
    for (const d of ABILITY_DIMENSIONS) observed[d] = { score: 60, hintDependency: 0 };
    observed["用户理解"] = { score: 50, hintDependency: dep }; // 最弱维度
    return profileView(observed);
  };

  it("弱项维度提示依赖高 → 优先标注「独立性训练」的题并写入理由", () => {
    const outcome = selectQuestion(
      baseInput({
        profile: observedAll(3.2), // > 2.5 → 高
        questions: [
          fixtureQuestion({ id: "q-normal", abilityTags: ["用户理解"], difficulty: 2 }),
          fixtureQuestion({
            id: "q-indie",
            abilityTags: ["用户理解"],
            difficulty: 2,
            caseBackground: {
              product: "练手产品——本题标注：独立性训练，适合不依赖提示完成。",
              audience: "测试用户",
              scenario: "测试场景",
              related_features: "测试功能",
              current_status: "测试现状",
            },
          }),
        ],
      }),
    );
    expect(outcome!.questionId).toBe("q-indie");
    expect(outcome!.independenceTraining).toBe(true);
    expect(outcome!.reason).toContain("提示依赖");
    expect(outcome!.reason).toContain("独立性训练");
  });

  it("提示依赖不高 → 不因独立性标注改变优先级", () => {
    const outcome = selectQuestion(
      baseInput({
        profile: observedAll(0.5),
        questions: [
          fixtureQuestion({ id: "q-normal", abilityTags: ["用户理解"], difficulty: 2 }),
          fixtureQuestion({
            id: "q-indie",
            abilityTags: ["用户理解"],
            difficulty: 4,
            caseBackground: { product: "独立性训练标注题" },
          }),
        ],
      }),
    );
    // 依赖不高：走难度梯度（弱项 50 分 → 目标难度 2），q-normal 命中
    expect(outcome!.questionId).toBe("q-normal");
    expect(outcome!.independenceTraining).toBe(false);
  });
});

describe("selectQuestion：过滤与放宽", () => {
  const questions = [
    fixtureQuestion({ id: "q-1", abilityTags: ["根因分析"] }),
    fixtureQuestion({ id: "q-2", abilityTags: ["根因分析"] }),
    fixtureQuestion({ id: "q-3", abilityTags: ["根因分析"] }),
  ];

  it("已练题目被过滤，理由不含已练题", () => {
    const outcome = selectQuestion(
      baseInput({
        questions,
        practicedQuestionIds: new Set(["q-1", "q-2"]),
      }),
    );
    expect(outcome!.questionId).toBe("q-3");
  });

  it("近期同类案例（同产品）被过滤", () => {
    const outcome = selectQuestion(
      baseInput({
        questions: [
          fixtureQuestion({
            id: "q-douyin",
            abilityTags: ["根因分析"],
            caseBackground: { product: "抖音——短视频平台。" },
          }),
          fixtureQuestion({
            id: "q-other",
            abilityTags: ["根因分析"],
            caseBackground: { product: "Keep——健身应用。" },
          }),
        ],
        recentCaseBackgrounds: [{ product: "抖音——短视频平台。" }],
      }),
    );
    expect(outcome!.questionId).toBe("q-other");
  });

  it("全已练 → 放宽已练过滤，按顺序取第一题并标注放宽说明", () => {
    const outcome = selectQuestion(
      baseInput({
        questions,
        practicedQuestionIds: new Set(["q-1", "q-2", "q-3"]),
      }),
    );
    expect(outcome).not.toBeNull();
    expect(outcome!.questionId).toBe("q-1");
    expect(outcome!.relaxedFilters).toContain("已练题目");
    expect(outcome!.reason).toContain("重练");
  });

  it("近期同类全部命中 → 放宽同类过滤，仍优先未练题", () => {
    const outcome = selectQuestion(
      baseInput({
        questions: [
          fixtureQuestion({
            id: "q-old",
            abilityTags: ["根因分析"],
            caseBackground: { product: "抖音——短视频平台。" },
          }),
          fixtureQuestion({
            id: "q-new",
            abilityTags: ["根因分析"],
            caseBackground: { product: "抖音——另一个案例。" },
          }),
        ],
        practicedQuestionIds: new Set(["q-old"]),
        recentCaseBackgrounds: [{ product: "抖音——短视频平台。" }],
      }),
    );
    expect(outcome!.questionId).toBe("q-new");
    expect(outcome!.relaxedFilters).toContain("近期同类案例");
  });

  it("候选池为空 → 返回 null（交由服务层降级）", () => {
    expect(selectQuestion(baseInput({ questions: [] }))).toBeNull();
  });

  it("近期同类窗口常量：只回看最近 N 次", () => {
    expect(RECENT_CASE_WINDOW).toBeGreaterThanOrEqual(2);
    expect(RECENT_CASE_WINDOW).toBeLessThanOrEqual(10);
  });
});

describe("selectQuestion：兴趣与难度梯度（图 2 H 节点）", () => {
  it("兴趣领域命中 → 同等条件下优先，并写入理由", () => {
    const outcome = selectQuestion(
      baseInput({
        interestAreas: ["内容/创作"],
        questions: [
          fixtureQuestion({ id: "q-plain", abilityTags: ["根因分析"], difficulty: 3 }),
          fixtureQuestion({
            id: "q-content",
            abilityTags: ["根因分析"],
            difficulty: 3,
            caseBackground: { product: "抖音——内容创作生态平台。" },
          }),
        ],
      }),
    );
    expect(outcome!.questionId).toBe("q-content");
    expect(outcome!.matchedInterest).toBe("内容/创作");
    expect(outcome!.reason).toContain("内容/创作");
  });

  it("兴趣无匹配 → 正常出题，理由不含兴趣段", () => {
    const outcome = selectQuestion(
      baseInput({
        interestAreas: ["出海/国际化"],
        questions: [fixtureQuestion({ id: "q-only", abilityTags: ["根因分析"] })],
      }),
    );
    expect(outcome!.questionId).toBe("q-only");
    expect(outcome!.matchedInterest).toBeNull();
    expect(outcome!.reason).not.toContain("出海/国际化");
  });

  it("难度梯度：探索期优先基础难度；强化期按弱项分数取目标难度", () => {
    // 探索期（全未知）：难度 2 优先于 4
    const exploration = selectQuestion(
      baseInput({
        questions: [
          fixtureQuestion({ id: "q-hard", abilityTags: ["根因分析"], difficulty: 4 }),
          fixtureQuestion({ id: "q-easy", abilityTags: ["根因分析"], difficulty: 2 }),
        ],
      }),
    );
    expect(exploration!.questionId).toBe("q-easy");

    // 强化期弱项 85 分 → 目标难度 4（挑战）
    const observed: Record<string, { score: number }> = {};
    for (const d of ABILITY_DIMENSIONS) observed[d] = { score: 90 };
    observed["根因分析"] = { score: 85 };
    const strengthening = selectQuestion(
      baseInput({
        profile: profileView(observed),
        questions: [
          fixtureQuestion({ id: "q-easy", abilityTags: ["根因分析"], difficulty: 2 }),
          fixtureQuestion({ id: "q-hard", abilityTags: ["根因分析"], difficulty: 4 }),
        ],
      }),
    );
    expect(strengthening!.questionId).toBe("q-hard");
  });
});

describe("selectQuestion：首次训练熟悉产品优先（D11）", () => {
  const douyin = fixtureQuestion({
    id: "q-douyin",
    abilityTags: ["用户理解"],
    caseTitle: "短视频霸主为何「倒退」做图文",
    caseBackground: { product: "抖音——字节跳动旗下短视频平台。" },
  });
  const notion = fixtureQuestion({
    id: "q-notion",
    abilityTags: ["用户理解"],
    caseBackground: { product: "Notion——一体化工作空间。" },
  });

  it("首次训练：熟悉产品命中的案例排到最前并写入理由", () => {
    const outcome = selectQuestion(
      baseInput({
        isFirstTraining: true,
        familiarProducts: ["抖音"],
        questions: [notion, douyin],
      }),
    );
    expect(outcome!.questionId).toBe("q-douyin");
    expect(outcome!.matchedFamiliarProduct).toBe("抖音");
    expect(outcome!.reason).toContain("首次训练");
    expect(outcome!.reason).toContain("抖音");
  });

  it("非首次训练：熟悉产品不影响排序", () => {
    const outcome = selectQuestion(
      baseInput({
        isFirstTraining: false,
        familiarProducts: ["抖音"],
        questions: [notion, douyin],
      }),
    );
    expect(outcome!.questionId).toBe("q-notion");
    expect(outcome!.matchedFamiliarProduct).toBeNull();
  });

  it("首次训练但熟悉产品无命中 → 正常排序，不写熟悉产品理由", () => {
    const outcome = selectQuestion(
      baseInput({
        isFirstTraining: true,
        familiarProducts: ["不存在的产品"],
        questions: [notion, douyin],
      }),
    );
    expect(outcome!.questionId).toBe("q-notion");
    expect(outcome!.matchedFamiliarProduct).toBeNull();
  });
});

describe("selectQuestion：目标维度无题覆盖的回退", () => {
  it("探索期没有任何题覆盖未知维度 → 回退全池按其余规则排序", () => {
    const observed: Record<string, { score: number }> = {};
    for (const d of ABILITY_DIMENSIONS) {
      if (d !== "产品表达") observed[d] = { score: 70 };
    }
    const outcome = selectQuestion(
      baseInput({
        profile: profileView(observed),
        questions: [fixtureQuestion({ id: "q-only", abilityTags: ["用户理解"] })],
      }),
    );
    expect(outcome).not.toBeNull();
    expect(outcome!.questionId).toBe("q-only");
    expect(outcome!.relaxedFilters).toContain("目标维度覆盖");
  });

  it("强化期没有任何题覆盖弱项 → 回退全池并在理由中说明", () => {
    const observed: Record<string, { score: number }> = {};
    for (const d of ABILITY_DIMENSIONS) observed[d] = { score: 70 };
    observed["产品表达"] = { score: 55 }; // 弱项
    const outcome = selectQuestion(
      baseInput({
        profile: profileView(observed),
        questions: [fixtureQuestion({ id: "q-only", abilityTags: ["用户理解"] })],
      }),
    );
    expect(outcome!.phase).toBe("strengthening");
    expect(outcome!.questionId).toBe("q-only");
    expect(outcome!.relaxedFilters).toContain("目标维度覆盖");
    expect(outcome!.reason).toContain("题库暂无覆盖弱项维度的可出题");
  });
});

describe("selectQuestion：画像数据防御分支", () => {
  it("画像为空数组 → 视为探索期，给出建立画像的通用理由", () => {
    const outcome = selectQuestion(
      baseInput({
        profile: [],
        questions: [fixtureQuestion({ id: "q-only" })],
      }),
    );
    expect(outcome!.phase).toBe("exploration");
    expect(outcome!.targetDimensions).toEqual([]);
    expect(outcome!.reason).toContain("暂无画像观测数据");
  });

  it("视图未带提示依赖分档时按数值兜底分档（高依赖仍优先独立性训练）", () => {
    const profile = ABILITY_DIMENSIONS.map((dimension) => ({
      dimension,
      observed: true,
      currentScore: dimension === "用户理解" ? 50 : 75,
      observationCount: 2,
      hintDependency: dimension === "用户理解" ? 3.0 : 0,
      hintDependencyBand: null, // 未带分档 → 引擎按 hintDependency 兜底
      trend: null,
      updatedAt: null,
    }));
    const outcome = selectQuestion(
      baseInput({
        profile,
        questions: [
          fixtureQuestion({ id: "q-normal", abilityTags: ["用户理解"], difficulty: 2 }),
          fixtureQuestion({
            id: "q-indie",
            abilityTags: ["用户理解"],
            difficulty: 2,
            caseBackground: { product: "练手产品——标注：独立性训练。" },
          }),
        ],
      }),
    );
    expect(outcome!.questionId).toBe("q-indie");
    expect(outcome!.independenceTraining).toBe(true);
  });
});
