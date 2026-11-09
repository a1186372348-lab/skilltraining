import { createHash } from "node:crypto";
import { buildRuntimeContract } from "./runtime-contract.ts";

const MODELS = new Set(["deepseek-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"]);
const FINISH_REASONS = new Set(["stop", "length", "content_filter", "tool_calls", "insufficient_system_resource"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asNonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function unknownRequestAudit(): ReturnType<typeof requestAudit> {
  return { requestModel: null, requestTemperature: null, requestTemperatureApplicability: null, requestTokenLimitField: "unknown", requestTokenLimit: null, requestThinking: "unknown", requestEffort: "unknown", requestContractHash: null };
}

export function requestAudit(runtime: ReturnType<typeof buildRuntimeContract>) {
  return {
    requestModel: runtime.model as string | null,
    requestTemperature: runtime.temperature as number | null,
    requestTemperatureApplicability: runtime.temperatureApplicability as string | null,
    requestTokenLimitField: runtime.maxTokensField as string,
    requestTokenLimit: runtime.maxTokens as number | null,
    requestThinking: runtime.thinking as string,
    requestEffort: runtime.effort as string,
    requestContractHash: runtime.hash as string | null,
  };
}

export function responseAudit(value: unknown) {
  const body = asRecord(value);
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = asRecord(choices[0]);
  const usage = asRecord(body.usage);
  const details = asRecord(usage.completion_tokens_details);
  const model = typeof body.model === "string" && MODELS.has(body.model) ? body.model : null;
  const finish = typeof choice.finish_reason === "string" && FINISH_REASONS.has(choice.finish_reason)
    ? choice.finish_reason : null;
  const fingerprint = typeof body.system_fingerprint === "string"
    && /^[A-Za-z0-9_-]{1,128}$/.test(body.system_fingerprint)
    ? body.system_fingerprint : null;
  return {
    responseServedModel: model,
    responseFinishReason: finish,
    responseReasoningTokens: asNonNegativeSafeInteger(details.reasoning_tokens),
    responseFingerprintHash: fingerprint === null ? null : createHash("sha256").update(fingerprint).digest("hex"),
  };
}
