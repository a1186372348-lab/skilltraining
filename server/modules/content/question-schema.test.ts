import { describe, expect, it } from "vitest";

import {
  ABILITY_DIMENSIONS,
  DIFFICULTY_LABELS,
  DIFFICULTY_TO_INT,
  QUESTION_STATUS,
  questionContentSchema,
} from "./question-schema.ts";

// 合法样本工厂：结构对齐 content/questions/draft/ 真实草案
function validQuestion() {
  return {
    id: "Q99",
    title: "样例题：某产品为什么做某功能",
    case_title: "样例案例标题",
    case_background: {
      product: "某产品介绍。",
      audience: "目标用户。",
      scenario: "典型场景。",
      related_features: "相关功能。",
      current_status: "当前状态。",
    },
    main_question: "如果你是该产品负责人，你会怎么做？",
    ability_tags: ["问题定义", "产品价值判断", "产品取舍"],
    difficulty: "中等",
    rubric: {
      dimensions: {
        问题定义: ["标准一", "标准二", "标准三"],
        产品价值判断: ["标准一", "标准二", "标准三", "标准四"],
        产品取舍: ["标准一", "标准二", "标准三", "标准四", "标准五"],
      },
      forbidden_leaks: ["禁止泄露点一"],
    },
    hint_tree: [1, 2, 3, 4, 5].map((level) => ({
      level,
      stage: `阶段${level}`,
      question: `第 ${level} 层提示问题？`,
    })),
    materials: {
      core: [
        { title: "核心一", source: "来源一", url: "https://example.com/a", summary: "摘要一" },
        { title: "核心二", source: "来源二", url: "https://example.com/b", summary: "摘要二" },
      ],
      extended: [
        { title: "扩展一", source: "来源三", url: "https://example.com/c", summary: "摘要三" },
        { title: "扩展二", source: "来源四", url: "https://example.com/d", summary: "摘要四" },
        { title: "扩展三", source: "来源五", url: "https://example.com/e", summary: "摘要五" },
      ],
    },
    uncertainty: ["某数据未官方确认。"],
    status: "draft",
  };
}

describe("题库内容 schema", () => {
  it("锁定 8 个一级能力维度枚举", () => {
    expect([...ABILITY_DIMENSIONS].sort()).toEqual(
      [
        "问题定义",
        "用户理解",
        "根因分析",
        "产品价值判断",
        "方案设计",
        "产品取舍",
        "指标与验证",
        "产品表达",
      ].sort(),
    );
  });

  it("锁定难度枚举与 1~5 整数映射（预留更细粒度两端）", () => {
    expect([...DIFFICULTY_LABELS]).toEqual(["基础", "中等", "挑战"]);
    expect(DIFFICULTY_TO_INT["基础"]).toBe(2);
    expect(DIFFICULTY_TO_INT["中等"]).toBe(3);
    expect(DIFFICULTY_TO_INT["挑战"]).toBe(4);
  });

  it("锁定 status 枚举", () => {
    expect([...QUESTION_STATUS]).toEqual(["draft", "published", "archived"]);
  });

  it("接受合法完整样本（含 uncertainty）", () => {
    const result = questionContentSchema.safeParse(validQuestion());
    expect(result.success).toBe(true);
  });

  it("接受缺省 uncertainty（可选字段）", () => {
    const q = validQuestion() as Record<string, unknown>;
    delete q.uncertainty;
    expect(questionContentSchema.safeParse(q).success).toBe(true);
  });

  describe("能力标签", () => {
    it("少于 2 个被拒绝", () => {
      const q = { ...validQuestion(), ability_tags: ["问题定义"] };
      const r = questionContentSchema.safeParse(q);
      expect(r.success).toBe(false);
    });

    it("多于 4 个被拒绝", () => {
      const q = {
        ...validQuestion(),
        ability_tags: ["问题定义", "用户理解", "根因分析", "产品价值判断", "方案设计"],
      };
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });

    it("枚举之外的标签被拒绝", () => {
      const q = { ...validQuestion(), ability_tags: ["问题定义", "增长黑客"] };
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });

    it("重复标签被拒绝", () => {
      const q = { ...validQuestion(), ability_tags: ["问题定义", "问题定义"] };
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });

    it("恰好 2 个与 4 个均接受", () => {
      const tags2 = { ...validQuestion(), ability_tags: ["问题定义", "用户理解"] };
      // rubric 维度需与标签一致
      tags2.rubric = {
        dimensions: { 问题定义: ["一", "二", "三"], 用户理解: ["一", "二", "三"] },
        forbidden_leaks: ["x"],
      } as never;
      expect(questionContentSchema.safeParse(tags2).success).toBe(true);

      const tags4 = {
        ...validQuestion(),
        ability_tags: ["问题定义", "用户理解", "根因分析", "产品表达"],
      };
      tags4.rubric = {
        dimensions: {
          问题定义: ["一", "二", "三"],
          用户理解: ["一", "二", "三"],
          根因分析: ["一", "二", "三"],
          产品表达: ["一", "二", "三"],
        },
        forbidden_leaks: ["x"],
      } as never;
      expect(questionContentSchema.safeParse(tags4).success).toBe(true);
    });
  });

  describe("难度", () => {
    it("枚举之外的难度被拒绝", () => {
      const q = { ...validQuestion(), difficulty: "地狱" };
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });
  });

  describe("Rubric", () => {
    it("缺 rubric 被拒绝", () => {
      const q = validQuestion() as Record<string, unknown>;
      delete q.rubric;
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });

    it("某维度标准少于 3 条被拒绝", () => {
      const q = validQuestion();
      q.rubric.dimensions["问题定义"] = ["只有两条", "两条"];
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });

    it("某维度标准多于 5 条被拒绝", () => {
      const q = validQuestion();
      q.rubric.dimensions["问题定义"] = ["一", "二", "三", "四", "五", "六"];
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });

    it("Rubric 维度缺少能力标签覆盖的维度被拒绝", () => {
      const q = validQuestion();
      const dimensions: Record<string, string[]> = { ...q.rubric.dimensions };
      delete dimensions["产品取舍"];
      q.rubric = { ...q.rubric, dimensions: dimensions as never };
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });

    it("Rubric 维度超出能力标签范围被拒绝", () => {
      const q = validQuestion();
      (q.rubric.dimensions as Record<string, string[]>)["指标与验证"] = ["一", "二", "三"];
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });

    it("缺 forbidden_leaks 被拒绝", () => {
      const q = validQuestion() as { rubric: Record<string, unknown> };
      delete q.rubric.forbidden_leaks;
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });

    it("forbidden_leaks 为空数组被拒绝", () => {
      const q = validQuestion();
      q.rubric.forbidden_leaks = [];
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });
  });

  describe("提示树", () => {
    it("少于 5 层被拒绝", () => {
      const q = validQuestion();
      q.hint_tree = q.hint_tree.slice(0, 4);
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });

    it("多于 5 层被拒绝", () => {
      const q = validQuestion();
      q.hint_tree = [...q.hint_tree, { level: 6, stage: "额外", question: "？" }];
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });

    it("层级不是 1~5 顺序被拒绝", () => {
      const q = validQuestion();
      q.hint_tree = q.hint_tree.map((h, i) => ({ ...h, level: i })); // 0~4
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });

    it("层级乱序被拒绝", () => {
      const q = validQuestion();
      const swapped = [...q.hint_tree];
      [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
      q.hint_tree = swapped;
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });

    it("缺 stage 或 question 被拒绝", () => {
      const q = validQuestion();
      const noStage = q.hint_tree.map((h) => ({ level: h.level, question: h.question }));
      expect(questionContentSchema.safeParse({ ...q, hint_tree: noStage }).success).toBe(false);
      const noQuestion = q.hint_tree.map((h) => ({ level: h.level, stage: h.stage }));
      expect(questionContentSchema.safeParse({ ...q, hint_tree: noQuestion }).success).toBe(false);
    });
  });

  describe("资料", () => {
    it("核心资料不是 2 篇被拒绝", () => {
      const q = validQuestion();
      q.materials.core = q.materials.core.slice(0, 1);
      expect(questionContentSchema.safeParse(q).success).toBe(false);

      const q3 = validQuestion();
      q3.materials.core = [...q3.materials.core, q3.materials.core[0]];
      expect(questionContentSchema.safeParse(q3).success).toBe(false);
    });

    it("扩展资料不是 3 篇被拒绝", () => {
      const q = validQuestion();
      q.materials.extended = q.materials.extended.slice(0, 2);
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });

    it("资料缺 url 或 url 非法被拒绝", () => {
      const q = validQuestion();
      const noUrl = { ...q.materials.core[0] } as Record<string, unknown>;
      delete noUrl.url;
      expect(
        questionContentSchema.safeParse({
          ...q,
          materials: { ...q.materials, core: [noUrl, q.materials.core[1]] },
        }).success,
      ).toBe(false);

      const badUrl = { ...q.materials.core[0], url: "不是链接" };
      expect(
        questionContentSchema.safeParse({
          ...q,
          materials: { ...q.materials, core: [badUrl, q.materials.core[1]] },
        }).success,
      ).toBe(false);
    });
  });

  describe("其他字段", () => {
    it("status 枚举之外被拒绝", () => {
      const q = { ...validQuestion(), status: "online" };
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });

    it("案例背景缺字段被拒绝", () => {
      const q = validQuestion();
      const background: Record<string, unknown> = { ...q.case_background };
      delete background.current_status;
      expect(questionContentSchema.safeParse({ ...q, case_background: background }).success).toBe(false);
    });

    it("id 含非法字符被拒绝", () => {
      expect(questionContentSchema.safeParse({ ...validQuestion(), id: "Q 01" }).success).toBe(false);
      expect(questionContentSchema.safeParse({ ...validQuestion(), id: "第一题" }).success).toBe(false);
    });

    it("未知顶层字段被拒绝（防止草案笔误静默通过）", () => {
      const q = { ...validQuestion(), typo_field: "x" };
      expect(questionContentSchema.safeParse(q).success).toBe(false);
    });
  });
});
