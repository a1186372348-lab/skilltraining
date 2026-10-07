import { z } from "zod";

// 题库内容 zod schema：对应 Prd.md 1.6 数据契约与 D1（每题含案例、主问题、能力标签、Rubric、难度、资料、5 层提示树）
// 校验目标是 content/questions/**/*.yaml 的内容契约；导入脚本按本 schema 过滤后才允许落库

// 8 个一级能力维度（Prd.md 1.2 锁定；能力标签与 Rubric 维度都只能用这些值）
export const ABILITY_DIMENSIONS = [
  "问题定义",
  "用户理解",
  "根因分析",
  "产品价值判断",
  "方案设计",
  "产品取舍",
  "指标与验证",
  "产品表达",
] as const;

// 难度枚举（YAML 用中文标签，可读可评审）
export const DIFFICULTY_LABELS = ["基础", "中等", "挑战"] as const;

// 难度标签到 questions.difficulty（Int 1~5）的映射：
// 取 2/3/4，两端 1 与 5 预留给未来更细粒度（R6 数据契约演化）
export const DIFFICULTY_TO_INT: Record<DifficultyLabel, number> = {
  基础: 2,
  中等: 3,
  挑战: 4,
};

// 上架状态枚举（与 prisma QuestionStatus 一一对应；仅 published 参与出题）
export const QUESTION_STATUS = ["draft", "published", "archived"] as const;

// 题目用途枚举（T17a / D19：与 prisma QuestionKind 一一对应；
// baseline 为能力基线测评题，不参与日常选题；缺省按 daily 处理）
export const QUESTION_KINDS = ["baseline", "daily"] as const;

export type AbilityDimension = (typeof ABILITY_DIMENSIONS)[number];
export type DifficultyLabel = (typeof DIFFICULTY_LABELS)[number];
export type QuestionStatusLabel = (typeof QUESTION_STATUS)[number];
export type QuestionKindLabel = (typeof QUESTION_KINDS)[number];

const nonEmpty = (label: string) => z.string().min(1, `${label}不能为空`);

const abilityTagSchema = z.enum(ABILITY_DIMENSIONS);

// 案例背景单字段（T13 / BR-8）：事实文本 + 引用编号（指向 case_sources，逐字段可核验）
// text  trim 后非空；citations 至少 1 个正整数编号（存在性由下方 superRefine 校验）
const caseFieldSchema = z.strictObject({
  text: z.string().trim().min(1, "案例背景字段 text 不能为空"),
  citations: z
    .array(z.number().int("引用编号必须是整数").positive("引用编号必须 ≥ 1"))
    .min(1, "案例背景字段 citations 不能为空（BR-8：每字段必须有来源标记）"),
});

// 案例背景五要素：产品 / 服务谁 / 场景 / 相关功能 / 当前状态（T13 新契约键名）
const caseBackgroundSchema = z.strictObject({
  product: caseFieldSchema,
  audience: caseFieldSchema,
  scenario: caseFieldSchema,
  features: caseFieldSchema,
  status: caseFieldSchema,
});

// 案例来源条目（T13 / BR-8）：id 从 1 连续编号（连续性由下方 superRefine 校验）；
// url 限定 http(s) 真实可打开链接（来源政策：官方一手 > 权威媒体 > 其他，publisher 如实标注）
const caseSourceSchema = z.strictObject({
  id: z.number().int("case_sources id 必须是整数").positive("case_sources id 必须 ≥ 1"),
  title: nonEmpty("case_sources title"),
  publisher: nonEmpty("case_sources publisher"),
  url: z.url({ protocol: /^https?$/, error: "case_sources url 必须是合法 http(s) 链接" }),
});

// 资料条目：标题 / 来源 / 原文链接 / 精编摘要
const materialItemSchema = z.strictObject({
  title: nonEmpty("资料 title"),
  source: nonEmpty("资料 source"),
  url: z.url("资料 url 必须是合法链接"),
  summary: nonEmpty("资料 summary"),
});

// Rubric：每个能力维度 3~5 条可观察标准 + 禁止泄露点（FR-10 / R2）
// 注意用 partialRecord：dimensions 只覆盖该题能力标签涉及的维度（2~4 个），
// 与能力标签的一一对应关系由下方 superRefine 校验
const rubricSchema = z.strictObject({
  dimensions: z.partialRecord(
    abilityTagSchema,
    z
      .array(nonEmpty("Rubric 标准"))
      .min(3, "Rubric 每个维度至少 3 条标准")
      .max(5, "Rubric 每个维度至多 5 条标准"),
  ),
  forbidden_leaks: z.array(nonEmpty("forbidden_leaks 条目")).min(1, "forbidden_leaks 至少 1 条"),
});

const hintLayerSchema = z.strictObject({
  level: z.number().int("提示层级必须是整数").min(1).max(5),
  stage: nonEmpty("提示 stage"),
  question: nonEmpty("提示 question"),
});

export const questionContentSchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "id 只能由字母、数字、连字符、下划线组成"),
    title: nonEmpty("title"),
    case_title: nonEmpty("case_title"),
    case_background: caseBackgroundSchema,
    case_sources: z.array(caseSourceSchema).min(1, "case_sources 至少 1 条（BR-8）"),
    main_question: nonEmpty("main_question"),
    ability_tags: z
      .array(abilityTagSchema)
      .min(2, "能力标签至少 2 个")
      .max(4, "能力标签至多 4 个"),
    difficulty: z.enum(DIFFICULTY_LABELS),
    rubric: rubricSchema,
    hint_tree: z.array(hintLayerSchema).length(5, "提示树必须恰好 5 层"),
    materials: z.strictObject({
      core: z.array(materialItemSchema).length(2, "核心资料必须恰好 2 篇"),
      extended: z.array(materialItemSchema).length(3, "扩展资料必须恰好 3 篇"),
    }),
    // 编辑注记（未经官方确认的数据说明），评审用，可选
    uncertainty: z.array(nonEmpty("uncertainty 条目")).optional(),
    status: z.enum(QUESTION_STATUS),
    // 题目用途（T17a / D19）：baseline 为基线测评题；缺省为日常题（daily）
    kind: z.enum(QUESTION_KINDS).optional(),
  })
  .superRefine((q, ctx) => {
    // 能力标签不可重复
    if (new Set(q.ability_tags).size !== q.ability_tags.length) {
      ctx.addIssue({ code: "custom", path: ["ability_tags"], message: "能力标签不可重复" });
    }
    // Rubric 维度必须与能力标签一一对应（BR-1：只对标签覆盖的维度评分）
    const dims = Object.keys(q.rubric.dimensions);
    const missing = q.ability_tags.filter((t) => !dims.includes(t));
    if (missing.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["rubric", "dimensions"],
        message: `Rubric 缺少能力标签对应维度：${missing.join("、")}`,
      });
    }
    const extra = dims.filter((d) => !(q.ability_tags as string[]).includes(d));
    if (extra.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["rubric", "dimensions"],
        message: `Rubric 存在能力标签之外的维度：${extra.join("、")}`,
      });
    }
    // 提示树层级必须恰好是 1~5 顺序（出题端按下标逐层释放）
    q.hint_tree.forEach((layer, index) => {
      if (layer.level !== index + 1) {
        ctx.addIssue({
          code: "custom",
          path: ["hint_tree", index, "level"],
          message: `提示树第 ${index + 1} 层 level 应为 ${index + 1}，实际为 ${layer.level}`,
        });
      }
    });
    // 案例来源 id 必须从 1 开始连续编号（BR-8：上标 [n] 与来源列表一一对应）
    q.case_sources.forEach((source, index) => {
      if (source.id !== index + 1) {
        ctx.addIssue({
          code: "custom",
          path: ["case_sources", index, "id"],
          message: `case_sources 第 ${index + 1} 条 id 应为 ${index + 1}，实际为 ${source.id}（id 从 1 连续编号）`,
        });
      }
    });
    // 五字段的每个引用 id 必须存在于 case_sources（BR-8：标号必须可溯源）
    const sourceIds = new Set(q.case_sources.map((source) => source.id));
    (
      Object.entries(q.case_background) as [
        keyof typeof q.case_background,
        { citations: number[] },
      ][]
    ).forEach(([field, value]) => {
      value.citations.forEach((citationId, citationIndex) => {
        if (!sourceIds.has(citationId)) {
          ctx.addIssue({
            code: "custom",
            path: ["case_background", field, "citations", citationIndex],
            message: `case_background.${field} 引用了不存在的来源 id ${citationId}`,
          });
        }
      });
    });
  });

export type QuestionContent = z.infer<typeof questionContentSchema>;
