import { describe, expect, it } from "vitest";

import {
  ABILITY_DIMENSIONS,
  DIFFICULTY_LABELS,
  DIFFICULTY_TO_INT,
  QUESTION_STATUS,
  questionContentSchema,
} from "./question-schema.ts";

// 合法样本工厂：结构对齐 content/questions/draft/ 真实草案（T13 新契约：
// 案例背景五字段均为 {text, citations[]}，配套 case_sources 编号来源列表）
function validQuestion() {
  return {
    id: "Q99",
    title: "样例题：某产品为什么做某功能",
    case_title: "样例案例标题",
    case_background: {
      product: { text: "某产品介绍。", citations: [1, 2] },
      audience: { text: "目标用户。", citations: [1] },
      scenario: { text: "典型场景。", citations: [2] },
      features: { text: "相关功能。", citations: [1, 2] },
      status: { text: "当前状态。", citations: [2] },
    },
    case_sources: [
      { id: 1, title: "来源一", publisher: "官方博客", url: "https://example.com/a" },
      { id: 2, title: "来源二", publisher: "权威媒体", url: "https://example.com/b" },
    ],
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
    domain: "工具/效率",
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
      delete background.status;
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

  describe("案例事实引用（T13 / BR-8：五字段 {text, citations[]} + case_sources）", () => {
    /** 取首个 issue 的 path 字符串，用于精确断言是预期规则拦截 */
    function firstIssuePath(q: unknown): string {
      const r = questionContentSchema.safeParse(q);
      if (r.success) return "";
      return r.error.issues[0]?.path.join(".") ?? "";
    }

    it("字段仍为旧版字符串形被拒绝（必须升级为 {text, citations}）", () => {
      const q = validQuestion();
      const background = { ...q.case_background, product: "旧版纯字符串" };
      const r = questionContentSchema.safeParse({ ...q, case_background: background });
      expect(r.success).toBe(false);
      expect(firstIssuePath({ ...q, case_background: background })).toContain("case_background.product");
    });

    it("字段缺 text 或 text 为空被拒绝", () => {
      const q = validQuestion();
      const noText = { ...q.case_background, audience: { citations: [1] } };
      expect(questionContentSchema.safeParse({ ...q, case_background: noText }).success).toBe(false);

      const emptyText = {
        ...q.case_background,
        audience: { text: "  ", citations: [1] },
      };
      // text 用空白串：min(1) 拦截的是空串；纯空白交给 trim 校验（见下方 GREEN 实现说明）
      const r = questionContentSchema.safeParse({ ...q, case_background: emptyText });
      expect(r.success).toBe(false);
    });

    it("字段缺 citations 或 citations 为空数组被拒绝", () => {
      const q = validQuestion();
      const noCitations = { ...q.case_background, scenario: { text: "有文本" } };
      const r1 = questionContentSchema.safeParse({ ...q, case_background: noCitations });
      expect(r1.success).toBe(false);

      const emptyCitations = { ...q.case_background, scenario: { text: "有文本", citations: [] } };
      const r2 = questionContentSchema.safeParse({ ...q, case_background: emptyCitations });
      expect(r2.success).toBe(false);
      expect(firstIssuePath({ ...q, case_background: emptyCitations })).toContain(
        "case_background.scenario.citations",
      );
    });

    it("citations 含非正整数编号被拒绝", () => {
      const q = validQuestion();
      const zero = { ...q.case_background, product: { text: "x", citations: [0] } };
      expect(questionContentSchema.safeParse({ ...q, case_background: zero }).success).toBe(false);
      const float = { ...q.case_background, product: { text: "x", citations: [1.5] } };
      expect(questionContentSchema.safeParse({ ...q, case_background: float }).success).toBe(false);
    });

    it("引用 id 不存在于 case_sources 被拒绝（BR-8：标号必须可溯源）", () => {
      const q = validQuestion();
      const dangling = { ...q.case_background, status: { text: "x", citations: [9] } };
      const r = questionContentSchema.safeParse({ ...q, case_background: dangling });
      expect(r.success).toBe(false);
      expect(firstIssuePath({ ...q, case_background: dangling })).toContain(
        "case_background.status.citations",
      );
    });

    it("缺 case_sources 或 case_sources 为空数组被拒绝", () => {
      const q = validQuestion() as Record<string, unknown>;
      delete q.case_sources;
      expect(questionContentSchema.safeParse(q).success).toBe(false);

      expect(questionContentSchema.safeParse({ ...validQuestion(), case_sources: [] }).success).toBe(
        false,
      );
    });

    it("case_sources id 必须从 1 开始连续编号", () => {
      const q = validQuestion();
      // 从 2 开始
      const from2 = [
        { id: 2, title: "来源一", publisher: "官方", url: "https://example.com/a" },
        { id: 3, title: "来源二", publisher: "媒体", url: "https://example.com/b" },
      ];
      expect(questionContentSchema.safeParse({ ...q, case_sources: from2 }).success).toBe(false);
      // 跳号不连续
      const gap = [
        { id: 1, title: "来源一", publisher: "官方", url: "https://example.com/a" },
        { id: 3, title: "来源二", publisher: "媒体", url: "https://example.com/b" },
      ];
      expect(questionContentSchema.safeParse({ ...q, case_sources: gap }).success).toBe(false);
      // 重复 id（同样破坏连续性）
      const dup = [
        { id: 1, title: "来源一", publisher: "官方", url: "https://example.com/a" },
        { id: 1, title: "来源二", publisher: "媒体", url: "https://example.com/b" },
      ];
      expect(questionContentSchema.safeParse({ ...q, case_sources: dup }).success).toBe(false);
    });

    it("case_sources 缺 title / publisher 被拒绝", () => {
      const q = validQuestion();
      const noPublisher = [
        { id: 1, title: "来源一", url: "https://example.com/a" },
        { id: 2, title: "来源二", publisher: "媒体", url: "https://example.com/b" },
      ];
      expect(questionContentSchema.safeParse({ ...q, case_sources: noPublisher }).success).toBe(
        false,
      );
      const noTitle = [
        { id: 1, publisher: "官方", url: "https://example.com/a" },
        { id: 2, title: "来源二", publisher: "媒体", url: "https://example.com/b" },
      ];
      expect(questionContentSchema.safeParse({ ...q, case_sources: noTitle }).success).toBe(false);
    });

    it("case_sources url 非法或非 http(s) 被拒绝", () => {
      const q = validQuestion();
      const notUrl = [
        { id: 1, title: "来源一", publisher: "官方", url: "不是链接" },
        { id: 2, title: "来源二", publisher: "媒体", url: "https://example.com/b" },
      ];
      expect(questionContentSchema.safeParse({ ...q, case_sources: notUrl }).success).toBe(false);
      // ftp 等非 http(s) 协议不允许（BR-8：真实可打开的网页来源）
      const ftp = [
        { id: 1, title: "来源一", publisher: "官方", url: "ftp://example.com/a" },
        { id: 2, title: "来源二", publisher: "媒体", url: "https://example.com/b" },
      ];
      const r = questionContentSchema.safeParse({ ...q, case_sources: ftp });
      expect(r.success).toBe(false);
      expect(firstIssuePath({ ...q, case_sources: ftp })).toContain("case_sources.0.url");
    });

    it("http 与 https 链接均接受", () => {
      const q = validQuestion();
      q.case_sources[0].url = "http://example.com/a";
      expect(questionContentSchema.safeParse(q).success).toBe(true);
    });
  });
});

describe("题库内容 schema：kind 题目用途（T17a / D19）", () => {
  it("缺省 kind 合法（日常题无需标注，默认 daily 由导入/数据库兜底）", () => {
    const q = validQuestion();
    expect(questionContentSchema.safeParse(q).success).toBe(true);
  });

  it("kind 为 baseline / daily 均合法", () => {
    const q = validQuestion();
    expect(questionContentSchema.safeParse({ ...q, kind: "baseline" }).success).toBe(true);
    expect(questionContentSchema.safeParse({ ...q, kind: "daily" }).success).toBe(true);
  });

  it("kind 为枚举之外的值被拒绝", () => {
    const q = validQuestion();
    expect(questionContentSchema.safeParse({ ...q, kind: "exam" }).success).toBe(false);
  });
});

describe("题库内容 schema：domain 领域标签（T33 / BR-V2-8）", () => {
  it("缺 domain 被拒绝（必填）", () => {
    const q = validQuestion() as Record<string, unknown>;
    delete q.domain;
    const r = questionContentSchema.safeParse(q);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.path.join(".")).toBe("domain");
    }
  });

  it("空串或纯空白被拒绝（trim 后必须非空）", () => {
    expect(questionContentSchema.safeParse({ ...validQuestion(), domain: "" }).success).toBe(false);
    expect(questionContentSchema.safeParse({ ...validQuestion(), domain: "   " }).success).toBe(false);
  });

  it("合法领域值通过，且首尾空白被 trim", () => {
    const r = questionContentSchema.safeParse({ ...validQuestion(), domain: " 内容/社交 " });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.domain).toBe("内容/社交");
    }
  });

  it("词表外的自由文本也通过（词表由评审口径管理，不进 schema 枚举）", () => {
    const r = questionContentSchema.safeParse({ ...validQuestion(), domain: "前沿科技" });
    expect(r.success).toBe(true);
  });
});
