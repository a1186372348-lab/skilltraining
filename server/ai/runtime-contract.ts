import { createHash } from "node:crypto";

export const DEFAULT_MAX_TOKENS = 24576;
export const REQUEST_MODEL = "deepseek-flash";

export class RuntimeContractError extends Error {
  constructor() {
    super("无效的 AI 运行配置");
    this.name = "RuntimeContractError";
  }
}

export function buildRuntimeContract(model: string, temperature: number, maxTokens = DEFAULT_MAX_TOKENS) {
  if (typeof model !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(model)
    || typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2
    || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > DEFAULT_MAX_TOKENS) {
    throw new RuntimeContractError();
  }
  const profile = {
    model,
    thinking: "enabled",
    effort: "high",
    maxTokensField: "max_tokens",
    maxTokens,
    temperature,
    temperatureApplicability: "ineffective_in_thinking",
  } as const;
  return { ...profile, hash: createHash("sha256").update(JSON.stringify(profile)).digest("hex") };
}
