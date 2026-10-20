import type { ChatMessage, AiClient } from "./client.ts";
import { createAiClientFromEnv } from "./client.ts";

/**
 * AI 追问生成（US-005 / BR-4 / FR-4；T19 / D22 扩展预生成提示；T35 / D37 追问闸门）。
 *
 * 输入：主问题 + 首答 + Rubric（含 forbidden_leaks）+ 主测维度（abilityTags[0]）；
 * 输出：同一次调用先判定「值不值得追问」（追问闸门，D37）——
 *   主测维度无重大缺项、证据链完整 → shouldFollowup=false，followups 为空数组，
 *   走零追问通道直进终答；否则产出 1~2 轮追问（D6 轮次硬上限 2，R2），
 *   每条追问附带一条预生成提示（D22：同一次 AI 调用产出并落库，用户点击时读库零等待）。
 * 判定理由 reason（中文一句话）随结果返回，由服务层落库审计，绝不下发前端。
 *
 * 防泄露设计（R2 / FR-10）：
 * - prompt 中以"禁止泄露点"清单做硬性负向约束，要求只提问、不点评、不公布答案要点；
 * - 提示是「思考支架」（引导方向、提示被忽略的因素类别），同样不得泄露 Rubric 要点；
 * - Rubric 只出现在服务端 prompt 中，响应只取判定结论、追问与提示文本本身；
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
  /** 主测维度（T35：abilityTags[0]，闸门判定锚点；缺失时降级为通用表述） */
  primaryDimension?: string;
}

/** 一条追问及其预生成提示（hint 为空串表示该轮无可用提示，前端不显示入口） */
export interface FollowupDraft {
  question: string;
  hint: string;
}

/**
 * 追问闸门判定结果（T35 / D37）：
 * - shouldFollowup=false：闸门跳过，走零追问通道直进终答，followups 恒为空数组；
 * - reason：判定理由（中文一句话），仅供落库审计，绝不下发前端。
 */
export interface FollowupGateResult {
  shouldFollowup: boolean;
  reason: string;
  followups: FollowupDraft[];
}

export class FollowupGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FollowupGenerationError";
  }
}

/** reason 缺省/为空时的兜底文案（判定理由必须非空，落库审计才有意义） */
const FALLBACK_REASON = "模型未给出判定理由";

export function buildFollowupMessages(input: FollowupInput): ChatMessage[] {
  const dimensionPoints = Object.entries(input.rubric.dimensions)
    .map(([dimension, points]) => `【${dimension}】\n${points.map((p) => `- ${p}`).join("\n")}`)
    .join("\n");
  const forbidden = input.rubric.forbidden_leaks.map((leak) => `- ${leak}`).join("\n");
  const gateAnchor = input.primaryDimension?.trim()
    ? `主测维度「${input.primaryDimension.trim()}」`
    : "本题训练重点的主测维度";

  return [
    {
      role: "system",
      content: [
        "你是一位资深产品总监，正在陪练一位初级产品经理。学员刚提交了对训练主问题的首次回答。你要先判定「是否需要追问」，再决定是否生成追问。",
        "",
        `第一步·判定（锚定${gateAnchor}的评分要点，从紧掌握）：`,
        "先判断首答是否存在「结构性缺陷」。结构性缺陷只有三类：",
        "① 主测维度要求的要素缺失或空洞（只有口号或现成观点复述、无具体对象与场景、无目标差距）；",
        "② 主测维度的核心结论完全没有任何事实或数据支撑（零证据的断言、把推测当事实、用后见之明倒推）；",
        "③ 对题意或案例事实有明显理解偏差。",
        "存在任一结构性缺陷 → 判定需要追问（should_followup=true）；三类都不存在 → 判定无需追问（should_followup=false）。",
        "达标即放行口径：主测维度要素齐备、核心结论已有至少一条事实或数据支撑、无明显理解偏差时，即视为无结构性缺陷，必须判定无需追问——证据还可更多、分析还可更深、次要论点还可更严谨，都不构成追问理由；",
        "从紧口径：仅在对「是否属于结构性缺陷」确实拿不准时按存在处理（宁可多追问一次，不可放过有缺项的答案）。",
        "",
        "第二步·生成（仅当判定需要追问时）：提出 1~2 个追问：找逻辑漏洞、挑战假设、索要证据，引导学员深化判断。",
        "同时为每条追问附带一条提示：提示是「思考支架」，引导思考方向、指出被忽略的因素类别，帮助学员自己想到答案，而不是替学员回答。",
        "",
        "硬性约束（必须全部遵守）：",
        "1. 只提问，不点评、不总结、不公布评分与参考答案；",
        "2. 追问、提示与判定理由都不得泄露、暗示或变相复述评分细则（Rubric）的任何要点，尤其不得提及或暗示以下「禁止泄露点」：",
        forbidden,
        "3. 追问必须针对学员首答中的具体主张，禁止空泛提问；",
        "4. 每条追问不超过 120 字，每条提示不超过 80 字，语气是严格但支持性的总监；",
        "5. reason 用中文一句话概括判定依据（如「主测维度要点覆盖完整，证据链闭环」「核心主张缺少证据支撑」），不得复述评分细则原文，仅用于内部审计，不展示给学员；",
        '6. 严格输出 JSON：{"should_followup": true 或 false, "reason": "判定理由", "followups": [{"question": "追问1", "hint": "提示1"}, {"question": "追问2（可选）", "hint": "提示2（可选）"}]}；should_followup=false 时 followups 输出空数组 []，追问 1~2 条。不要输出任何其他内容。',
        "",
        "以下评分细则仅供你判定「是否需要追问」以及「该往哪个方向追问与引导」，绝不可出现在追问、提示与判定理由文本中：",
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

function parseReason(raw: unknown): string {
  return typeof raw === "string" && raw.trim() ? raw.trim() : FALLBACK_REASON;
}

/**
 * 从模型输出解析闸门判定结果（T35 / D37）：容忍 ```json 代码块包裹。
 * 解析规则（稳健优先）：
 * - should_followup=false：闸门结论优先——即便模型误附追问也一律丢弃，followups 恒为空；
 * - should_followup=true 或缺省：解析 followups（截断到 2 条，R2 硬上限）；
 *   有效追问为空时抛错（输出自相矛盾，按生成失败处理，服务层落失败空数组、可重试）；
 * - 非 JSON / 缺 followups 数组且未判定跳过：抛 FollowupGenerationError。
 */
export function parseFollowupGateOutput(content: string): FollowupGateResult {
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
  const record = data as { should_followup?: unknown; reason?: unknown; followups?: unknown };
  const reason = parseReason(record?.reason);

  // 闸门跳过：结论优先，追问一律丢弃
  if (record?.should_followup === false) {
    return { shouldFollowup: false, reason, followups: [] };
  }

  const list = record?.followups;
  if (!Array.isArray(list)) {
    throw new FollowupGenerationError("追问输出缺少 followups 数组");
  }
  const followups = list
    .map(parseFollowupItem)
    .filter((item): item is FollowupDraft => item !== null)
    .slice(0, 2);
  if (followups.length === 0) {
    throw new FollowupGenerationError("判定需要追问但有效追问为空");
  }
  return { shouldFollowup: true, reason, followups };
}

export interface GenerateFollowupsDeps {
  client?: AiClient;
}

export async function generateFollowups(
  input: FollowupInput,
  deps: GenerateFollowupsDeps = {},
): Promise<FollowupGateResult> {
  const client = deps.client ?? createAiClientFromEnv();
  const result = await client.chatCompletion({
    messages: buildFollowupMessages(input),
    temperature: 0.3, // 低 temperature（R1/R2：减少自由发挥）
    // deepseek-flash 为推理模型（D39）：推理 token 计入 max_completion_tokens，
    // 预算过小会导致正文被截空（T22 起「200 空 content」已纳入网关重试）。
    // T19 起每条追问附带一条提示，T35 起追加判定字段，产出略增；4096 是余量而非必需。
    maxCompletionTokens: 4096,
    responseFormat: { type: "json_object" },
  });
  return parseFollowupGateOutput(result.content);
}
