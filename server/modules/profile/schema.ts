import { z } from "zod";

/**
 * 初始用户画像问卷的输入校验（Prd.md US-001 / 1.6 数据契约 / T04）。
 * 约定：
 * - 职位、年限、行业为必填（选择为主，3 分钟内可完成）；
 * - 项目经验、学习目标为非关键项，允许跳过（空串归一化为缺省）；
 * - 熟悉产品、兴趣领域、自评方向为多值，服务端统一 trim、去空、去重；
 * - 草稿为提交Schema的全可选版本，允许只填了任意子集时暂存。
 */

/** 8 个能力一级维度（Prd.md 1.3），自评方向的可选范围。 */
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

/** 问卷预设选项（表单以选择为主；服务端不强制枚举，便于后续调整选项） */
export const POSITION_OPTIONS = [
  "产品经理",
  "产品运营",
  "项目经理",
  "增长/商业化",
  "设计师/研发转岗",
  "其他",
] as const;

export const YEARS_EXPERIENCE_OPTIONS = [
  "0-1年",
  "1-3年",
  "3-5年",
  "5-10年",
  "10年以上",
] as const;

export const INDUSTRY_OPTIONS = [
  "互联网/软件",
  "电商/零售",
  "金融",
  "教育",
  "企业服务/SaaS",
  "硬件/IoT",
  "内容/媒体",
  "其他",
] as const;

export const INTEREST_AREA_OPTIONS = [
  "AI 应用",
  "效率工具",
  "增长/商业化",
  "社交/社区",
  "电商/交易",
  "内容/创作",
  "出海/国际化",
  "企业协作",
] as const;

export const FAMILIAR_PRODUCT_SUGGESTIONS = [
  "微信",
  "飞书",
  "抖音",
  "小红书",
  "Notion",
  "钉钉",
  "淘宝",
  "B站",
] as const;

/** 多值字段上限 */
const MULTI_VALUE_MAX = 10;
const MULTI_ITEM_MAX = 50;

/** 可选文本：trim + 限长，空白串归一化为 undefined（允许跳过非关键项） */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));
}

/** 多值字段：元素 trim 限长，过滤空白、去重 */
function multiValue(maxItems: number) {
  return z
    .array(z.string().trim().max(MULTI_ITEM_MAX))
    .max(maxItems)
    .transform((list) => [...new Set(list.filter((item) => item.length > 0))]);
}

/** 字段基础定义（不含默认值，供提交/草稿两个 Schema 复用） */
const baseFields = {
  position: z.string().trim().min(1).max(50),
  yearsExperience: z.string().trim().min(1).max(30),
  industry: z.string().trim().min(1).max(50),
  projectExperience: optionalText(300),
  familiarProducts: multiValue(MULTI_VALUE_MAX),
  interestAreas: multiValue(MULTI_VALUE_MAX),
  learningGoal: optionalText(200),
  selfAssessment: z
    .array(z.enum(ABILITY_DIMENSIONS))
    .max(ABILITY_DIMENSIONS.length)
    .transform((list) => [...new Set(list)]),
};

/** 提交校验：写 user_profiles 前的完整校验（多值字段缺省归一化为空数组） */
export const profileSubmitSchema = z.object({
  ...baseFields,
  familiarProducts: baseFields.familiarProducts.default([]),
  interestAreas: baseFields.interestAreas.default([]),
  selfAssessment: baseFields.selfAssessment.default([]),
});

/** 草稿校验：全部字段可缺省，仅校验已填部分；不注入默认值，保留"未填"语义 */
export const profileDraftSchema = z.object(baseFields).partial();

export type ProfileSubmitInput = z.infer<typeof profileSubmitSchema>;
export type ProfileDraftInput = z.infer<typeof profileDraftSchema>;
