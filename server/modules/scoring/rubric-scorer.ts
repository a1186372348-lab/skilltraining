import type { ChatMessage, MimoClient } from "../../ai/mimo-client.ts";
import { createMimoClientFromEnv } from "../../ai/mimo-client.ts";

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
 */

export interface RubricScoringInput {
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
        "硬性约束（必须全部遵守）：",
        "1. 只对我列出的能力维度评分，每个维度给出 0~100 的原始表现分；",
        "2. 评分必须逐条对照每个维度的 Rubric 可观察标准，以学员最终回答为评分主体，首答与追问用于理解思路变化；",
        "3. 每个维度的诊断必须引用学员答案中的具体内容（原话或具体主张）作为证据，说清做到了什么、缺了什么；",
        "4. 「最需要优化的一个问题」必须是单一、具体、可行动的问题：指出学员答案中哪一句或哪一个主张有问题、为什么、应该怎么改；禁止「建议加强产品思维」「提升用户感知」「多考虑用户」一类泛泛结论；",
        "5. 「下一步训练方向」必须指向具体维度与具体问题类型，一句话；",
        '6. 严格输出 JSON：{"dimensions":[{"dimension":"维度名","raw_score":0~100,"diagnosis":"..."}],"top_issue":"...","next_focus":"..."}，不要输出任何其他内容。',
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "【训练主问题】",
        input.mainQuestion,
        "",
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
  client?: MimoClient;
}

export async function scoreWithRubric(
  input: RubricScoringInput,
  deps: ScoreWithRubricDeps = {},
): Promise<RubricScoringOutput> {
  const client = deps.client ?? createMimoClientFromEnv();
  const result = await client.chatCompletion({
    messages: buildScoringMessages(input),
    temperature: 0.2, // 低 temperature（R1：评分一致性对策）
    // mimo-v2.6-pro 为推理模型：推理 token 计入 max_completion_tokens，
    // 多维度诊断的结构化输出预算给足，避免正文被截空
    maxCompletionTokens: 4096,
    responseFormat: { type: "json_object" },
  });
  return parseScoringOutput(result.content, Object.keys(input.rubricDimensions));
}
