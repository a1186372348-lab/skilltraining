import { computeContentHash, parsePromptContent, serializePromptContent } from "./registry.ts";
import type { PromptTemplatePair } from "./template.ts";

const CONTRACTS = { v8: "gate-evidence-v1", v9: "gate-evidence-v2", v10: "gate-evidence-v2" } as const;

export class PromptContractError extends Error {
  constructor() {
    super("提示模板协议无效");
    this.name = "PromptContractError";
  }
}

/** 版本登记表是唯一可信分派依据，未知无字段版本维持历史解析。 */
export function parseTrustedPrompt(
  name: string,
  version: string,
  content: string,
  contentHash?: string,
): PromptTemplatePair | null {
  const expected = name === "followup" && Object.hasOwn(CONTRACTS, version)
    ? CONTRACTS[version as keyof typeof CONTRACTS] : undefined;
  const strict = expected !== undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    if (strict) throw new PromptContractError();
    return null;
  }
  const object = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown> : null;
  const declared = object !== null && Object.hasOwn(object, "outputContract");
  if (!strict && !declared) return parsePromptContent(content);
  if (!strict || !object || object.outputContract !== expected ||
    typeof object.system !== "string" || typeof object.user !== "string") {
    throw new PromptContractError();
  }
  const pair = { system: object.system, user: object.user, outputContract: expected! } as const;
  if (serializePromptContent(pair) !== content ||
    (contentHash !== undefined && computeContentHash(content) !== contentHash)) {
    throw new PromptContractError();
  }
  return pair;
}
