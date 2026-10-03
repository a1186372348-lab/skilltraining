import type { ChatMessage, MimoClient } from "./mimo-client.ts";
import { createMimoClientFromEnv } from "./mimo-client.ts";

/**
 * AI 追问生成（US-005 / BR-4 / FR-4）。
 *
 * 输入：主问题 + 首答 + Rubric（含 forbidden_leaks）；
 * 输出：1~2 轮追问文本（D6 轮次硬上限 2，R2）。
 *
 * 防泄露设计（R2 / FR-10）：
 * - prompt 中以"禁止泄露点"清单做硬性负向约束，要求只提问、不点评、不公布答案要点；
 * - Rubric 只出现在服务端 prompt 中，响应只取追问文本本身；
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
        "",
        "硬性约束（必须全部遵守）：",
        "1. 只提问，不点评、不总结、不公布评分与参考答案；",
        "2. 不得泄露、暗示或变相复述评分细则（Rubric）的任何要点，尤其不得提及或暗示以下「禁止泄露点」：",
        forbidden,
        "3. 追问必须针对学员首答中的具体主张，禁止空泛提问；",
        "4. 每条追问不超过 120 字，语气是严格但支持性的总监；",
        '5. 严格输出 JSON：{"followups": ["追问1", "追问2（可选）"]}，1~2 条，不要输出任何其他内容。',
        "",
        "以下评分细则仅供你判断「该往哪个方向追问」，绝不可出现在追问文本中：",
        dimensionPoints,
      ].join("\n"),
    },
    {
      role: "user",
      content: [`【训练主问题】`, input.mainQuestion, "", `【学员首次回答】`, input.firstAnswer].join("\n"),
    },
  ];
}

/** 从模型输出解析追问数组：容忍 ```json 代码块包裹，截断到 2 条 */
export function parseFollowups(content: string): string[] {
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
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
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
): Promise<string[]> {
  const client = deps.client ?? createMimoClientFromEnv();
  const result = await client.chatCompletion({
    messages: buildFollowupMessages(input),
    temperature: 0.3, // 低 temperature（R1/R2：减少自由发挥）
    // mimo-v2.6-pro 为推理模型：推理 token 计入 max_completion_tokens，
    // 预算过小会导致正文被截空（实测 800 下返回空 content）
    maxCompletionTokens: 2048,
    responseFormat: { type: "json_object" },
  });
  return parseFollowups(result.content);
}
