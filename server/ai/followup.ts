import type { ChatMessage, MimoClient } from "./mimo-client.ts";
import { createMimoClientFromEnv } from "./mimo-client.ts";

/**
 * AI 追问生成（US-005 / BR-4 / FR-4；T19 / D22 扩展预生成提示）。
 *
 * 输入：主问题 + 首答 + Rubric（含 forbidden_leaks）；
 * 输出：1~2 轮追问文本（D6 轮次硬上限 2，R2），每条追问附带一条预生成提示
 * （D22：同一次 AI 调用产出并落库，用户点击时读库零等待，不引入二次 AI 延迟）。
 *
 * 防泄露设计（R2 / FR-10）：
 * - prompt 中以"禁止泄露点"清单做硬性负向约束，要求只提问、不点评、不公布答案要点；
 * - 提示是「思考支架」（引导方向、提示被忽略的因素类别），同样不得泄露 Rubric 要点；
 * - Rubric 只出现在服务端 prompt 中，响应只取追问与提示文本本身；
 * - 低 temperature + json_object 结构化输出，降低自由发挥概率。
 */

export interface FollowupRubric {
  dimensions: Record<string, string[]>;
  forbidden_leaks: string[];
}

export interface FollowupInput {
  mainQuestion: string;
  firstAnswer: string;
  rubric: FollowupRubric;
}

/** 一条追问及其预生成提示（hint 为空串表示该轮无可用提示，前端不显示入口） */
export interface FollowupDraft {
  question: string;
  hint: string;
}

export class FollowupGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FollowupGenerationError";
  }
}

export function buildFollowupMessages(input: FollowupInput): ChatMessage[] {
  const dimensionPoints = Object.entries(input.rubric.dimensions)
    .map(([dimension, points]) => `【${dimension}】\n${points.map((p) => `- ${p}`).join("\n")}`)
    .join("\n");
  const forbidden = input.rubric.forbidden_leaks.map((leak) => `- ${leak}`).join("\n");

  return [
    {
      role: "system",
      content: [
        "你是一位资深产品总监，正在陪练一位初级产品经理。学员刚提交了对训练主问题的首次回答，你要提出 1~2 个追问：找逻辑漏洞、挑战假设、索要证据，引导学员深化判断。",
        "同时为每条追问附带一条提示：提示是「思考支架」，引导思考方向、指出被忽略的因素类别，帮助学员自己想到答案，而不是替学员回答。",
        "",
        "硬性约束（必须全部遵守）：",
        "1. 只提问，不点评、不总结、不公布评分与参考答案；",
        "2. 追问与提示都不得泄露、暗示或变相复述评分细则（Rubric）的任何要点，尤其不得提及或暗示以下「禁止泄露点」：",
        forbidden,
        "3. 追问必须针对学员首答中的具体主张，禁止空泛提问；",
        "4. 每条追问不超过 120 字，每条提示不超过 80 字，语气是严格但支持性的总监；",
        '5. 严格输出 JSON：{"followups": [{"question": "追问1", "hint": "提示1"}, {"question": "追问2（可选）", "hint": "提示2（可选）"}]}，1~2 条，不要输出任何其他内容。',
        "",
        "以下评分细则仅供你判断「该往哪个方向追问与引导」，绝不可出现在追问与提示文本中：",
        dimensionPoints,
      ].join("\n"),
    },
    {
      role: "user",
      content: [`【训练主问题】`, input.mainQuestion, "", `【学员首次回答】`, input.firstAnswer].join("\n"),
    },
  ];
}

/** 单条追问条目解析：新结构 {question, hint}；兼容旧结构纯字符串（hint 降级为空串） */
function parseFollowupItem(item: unknown): FollowupDraft | null {
  if (typeof item === "string") {
    const question = item.trim();
    return question ? { question, hint: "" } : null;
  }
  if (typeof item === "object" && item !== null) {
    const record = item as { question?: unknown; hint?: unknown };
    if (typeof record.question !== "string" || !record.question.trim()) return null;
    // hint 缺失/为空降级为空串，不因此丢弃追问（前端按无提示处理，不显示入口）
    const hint = typeof record.hint === "string" ? record.hint.trim() : "";
    return { question: record.question.trim(), hint };
  }
  return null;
}

/** 从模型输出解析追问数组：容忍 ```json 代码块包裹，截断到 2 条 */
export function parseFollowups(content: string): FollowupDraft[] {
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch {
    throw new FollowupGenerationError("追问输出不是合法 JSON");
  }
  const list = (data as { followups?: unknown })?.followups;
  if (!Array.isArray(list)) {
    throw new FollowupGenerationError("追问输出缺少 followups 数组");
  }
  const followups = list
    .map(parseFollowupItem)
    .filter((item): item is FollowupDraft => item !== null)
    .slice(0, 2);
  if (followups.length === 0) {
    throw new FollowupGenerationError("追问输出为空");
  }
  return followups;
}

export interface GenerateFollowupsDeps {
  client?: MimoClient;
}

export async function generateFollowups(
  input: FollowupInput,
  deps: GenerateFollowupsDeps = {},
): Promise<FollowupDraft[]> {
  const client = deps.client ?? createMimoClientFromEnv();
  const result = await client.chatCompletion({
    messages: buildFollowupMessages(input),
    temperature: 0.3, // 低 temperature（R1/R2：减少自由发挥）
    // mimo-v2.6-pro 为推理模型：推理 token 计入 max_completion_tokens，
    // 预算过小会导致正文被截空（实测 800 下返回空 content）。
    // T19 起每条追问附带一条提示，产出略增；T22 起「200 空 content」已纳入重试。
    // 2026-10-07 实测：2048 在 MiMo 高负载推理下再次出现空 content 截断，
    // 同输入复测 623 tokens 即可成功——4096 是余量而非必需。
    maxCompletionTokens: 4096,
    responseFormat: { type: "json_object" },
  });
  return parseFollowups(result.content);
}
