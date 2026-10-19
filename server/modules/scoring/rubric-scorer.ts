import type { ChatMessage, AiClient } from "../../ai/client.ts";
import { createAiClientFromEnv } from "../../ai/client.ts";

import { SCORING_ERROR_CODES as CODES, ScoringError } from "./errors.ts";

/**
 * Rubric 评分调用（US-006 / BR-1 / BR-7 / FR-5，R1 一致性对策）。
 *
 * 输入：主问题 + 该题能力标签覆盖维度的 Rubric + 首答/追问/终答全文；
 * 输出：每维度原始表现分（0~100）+ 每维度诊断 + 一个最需优化的具体问题 + 下一步方向。
 *
 * 一致性设计（R1）：
 * - json_object 结构化输出 + 低 temperature（0.2）；
 * - prompt 内硬性约束 BR-7：最需优化问题必须具体、可行动、引用学员答案证据，
 *   禁止「建议加强产品思维」式泛泛结论；
 * - 输出逐字段校验，解析失败抛 ScoringError(SCORING_OUTPUT_INVALID)，
 *   服务层据此不落库、安全重试。
 * - 分数档锚定（六档，先定档再定分）+ 立场中立与承认未知保护，抑制中间档压缩（T33 校准 R2）。
 * - 主测维度显性化 + 缺陷按维度归因 + 诊断事实纪律（T33 校准 R3：人审复核发现的错归因与分数未兑现问题）。
 */

export interface RubricScoringInput {
  /** 本题主测维度：分数由主问题对应任务的完成度决定，top_issue 优先从这里产生 */
  mainDimension: string;
  mainQuestion: string;
  /** 仅该题能力标签覆盖的维度（BR-1）：维度 -> Rubric 可观察标准 */
  rubricDimensions: Record<string, string[]>;
  firstAnswer: string;
  /** 追问问题列表（BR-4，1~2 轮；无追问时为空数组） */
  followupQuestions: string[];
  finalAnswer: string;
}

export interface DimensionScoring {
  dimension: string;
  /** 原始表现分（0~100） */
  rawScore: number;
  /** 该维度诊断（引用学员答案证据） */
  diagnosis: string;
}

export interface RubricScoringOutput {
  dimensions: DimensionScoring[];
  /** 最需要优化的一个具体问题（BR-7） */
  topIssue: string;
  /** 下一步训练方向 */
  nextFocus: string;
}

export function buildScoringMessages(input: RubricScoringInput): ChatMessage[] {
  const dimensionBlocks = Object.entries(input.rubricDimensions)
    .map(([dimension, points]) => `【${dimension}】\n${points.map((p) => `- ${p}`).join("\n")}`)
    .join("\n");
  const followupBlock =
    input.followupQuestions.length > 0
      ? input.followupQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")
      : "（无追问）";

  return [
    {
      role: "system",
      content: [
        "你是一位资深产品总监，正在按评分细则（Rubric）为一位初级产品经理的训练作答评分。",
        "",
        "评分口径（0~100，先定档、再定分）：",
        "1. 先逐条对照该维度的 Rubric 标准，判断学员落在哪个分数档；再在档内按完成度给出具体分数。",
        "2. 分数档定义：90~100 优秀（各条标准基本达成，仅有表述强度等次要问题）；80~89 高质量（任务完整、论证有依据，存在少量可修正的论证边界问题）；70~79 较好但有明显缺项（主体任务完成，1~2 条标准明显未达成）；60~69 部分达标（多条标准未达成，但方向正确、有实质内容）；40~59 较弱（仅沾边，论证薄弱或关键任务缺失）；0~39 低质量（未完成任务、套话堆砌、缺乏证据或违背题目约束）。",
        "3. 缺项影响档内位置；只有某条关键标准整体未达成时才降档，不得因存在任何缺项就跨档压低。",
        "",
        "评分纪律（必须全部遵守）：",
        "1. 只对我列出的能力维度评分，每个维度给出 0~100 的原始表现分；",
        "2. 评分必须逐条对照每个维度的 Rubric 可观察标准，以学员最终回答为评分主体，首答与追问用于理解思路变化；",
        "3. 缺陷归因必须准确：每条缺陷归入其直接对应的 Rubric 条目所属维度扣分，不得把只属于某一维度的缺陷同时压低其他维度；「题目要求」「题目明确要求」一类断言必须能逐字对应主问题或该维度 Rubric 条目原文，不得自行增设考点；",
        "4. 学员的立场方向（支持/反对/暂缓/折中）不影响得分，只评价论证质量与证据匹配程度；",
        "5. 「暂缓判断、条件式结论」只要给出具体未知、所需证据与过渡或验证安排，就是合法的高质量作答形态，按论证质量评分；只有空泛宣称「信息不足」、不利用已有信息也不说明什么证据能改变判断的，才按未完成处理；",
        "6. 评价方案类答案时，检查方案内部规则是否自洽（是否相互矛盾、是否引入新的公平性或激励漏洞）；此类机制漏洞记入方案设计维度分数；题目允许时，验证型/分阶段提案是合法产出形态，不因「未给出完整终稿」而压低；",
        "7. 每个维度的诊断必须引用学员答案中的具体内容（原话或具体主张）作为证据，说清做到了什么、缺了什么；诊断与分数必须相互印证：指出的每条实质缺陷都应兑现为档内降分或降档——存在实质缺陷（漏项、推理跳跃、事实错误）的维度不得进入优秀档（90+），缺陷涉及该维度关键标准时按严重程度降档，不得在指出缺陷后仍维持原分数档；",
        "8. 诊断与建议中的事实断言以案例材料与题目提供的信息为准；材料未覆盖的外部事实（竞品机制、监管结论、行业数据等）只能表述为「需核实」，不得作为事实断言或标准答案的内容；",
        "9. 「最需要优化的一个问题」必须是单一、具体、可行动的问题：指出学员答案中哪一句或哪一个主张有问题、为什么、应该怎么改；它必须优先从主测维度的最关键缺陷中产生（主测维度无实质缺陷时才可选择辅测维度的问题）；禁止「建议加强产品思维」「提升用户感知」「多考虑用户」一类泛泛结论；",
        "10. 「下一步训练方向」必须指向具体维度与具体问题类型，一句话；",
        '11. 严格输出 JSON：{"dimensions":[{"dimension":"维度名","raw_score":0~100,"diagnosis":"..."}],"top_issue":"...","next_focus":"..."}，不要输出任何其他内容。',
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "【训练主问题】",
        input.mainQuestion,
        "",
        `本题主测维度：${input.mainDimension}（其分数由主问题对应任务的完成度决定，「最需要优化的一个问题」优先从这里产生）`,
        "【评分维度与 Rubric 标准】",
        dimensionBlocks,
        "",
        "【学员首次回答】",
        input.firstAnswer,
        "",
        "【AI 总监追问记录】",
        followupBlock,
        "",
        "【学员最终回答】",
        input.finalAnswer,
        "",
        "请按 Rubric 评分并严格输出 JSON。",
      ].join("\n"),
    },
  ];
}

function fail(message: string): never {
  throw new ScoringError(CODES.SCORING_OUTPUT_INVALID, 500, `AI 评分输出校验失败：${message}`);
}

function parseDimensionEntry(entry: unknown): DimensionScoring {
  if (typeof entry !== "object" || entry === null) fail("dimensions 元素不是对象");
  const record = entry as Record<string, unknown>;
  if (typeof record.dimension !== "string" || record.dimension.trim().length === 0) {
    fail("dimensions 元素缺少 dimension");
  }
  const rawScore = record.raw_score;
  if (typeof rawScore !== "number" || !Number.isFinite(rawScore) || rawScore < 0 || rawScore > 100) {
    fail(`维度 ${record.dimension} 的 raw_score 不是 0~100 的数字`);
  }
  if (typeof record.diagnosis !== "string" || record.diagnosis.trim().length === 0) {
    fail(`维度 ${record.dimension} 的诊断为空（BR-7 不允许无证据诊断）`);
  }
  return { dimension: record.dimension.trim(), rawScore, diagnosis: record.diagnosis.trim() };
}

/**
 * 解析评分输出：容忍 ```json 代码块包裹；忽略请求维度之外的多余维度；
 * 按请求维度顺序返回；任一校验失败抛 ScoringError(SCORING_OUTPUT_INVALID)。
 */
export function parseScoringOutput(
  content: string,
  requestedDimensions: string[],
): RubricScoringOutput {
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch {
    fail("输出不是合法 JSON");
  }
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.dimensions)) fail("缺少 dimensions 数组");
  const parsed = record.dimensions.map(parseDimensionEntry);

  const dimensions = requestedDimensions.map((dimension) => {
    const hit = parsed.find((d) => d.dimension === dimension);
    if (!hit) fail(`输出缺少请求维度：${dimension}`);
    return hit;
  });

  if (typeof record.top_issue !== "string" || record.top_issue.trim().length === 0) {
    fail("top_issue 为空（BR-7 要求必须输出一个具体问题）");
  }
  if (typeof record.next_focus !== "string" || record.next_focus.trim().length === 0) {
    fail("next_focus 为空");
  }
  return {
    dimensions,
    topIssue: record.top_issue.trim(),
    nextFocus: record.next_focus.trim(),
  };
}

export interface ScoreWithRubricDeps {
  client?: AiClient;
}

export async function scoreWithRubric(
  input: RubricScoringInput,
  deps: ScoreWithRubricDeps = {},
): Promise<RubricScoringOutput> {
  const client = deps.client ?? createAiClientFromEnv();
  const result = await client.chatCompletion({
    messages: buildScoringMessages(input),
    temperature: 0.2, // 低 temperature（R1：评分一致性对策）
    // deepseek-flash 为推理模型（D39）：推理 token 计入 max_completion_tokens，
    // 多维度诊断的结构化输出预算给足，避免正文被截空
    maxCompletionTokens: 4096,
    responseFormat: { type: "json_object" },
  });
  return parseScoringOutput(result.content, Object.keys(input.rubricDimensions));
}
