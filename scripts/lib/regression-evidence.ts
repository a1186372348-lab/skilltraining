import { createHash } from "node:crypto";
import { buildRuntimeContract, REQUEST_MODEL } from "../../server/ai/runtime-contract.ts";

export function followupEvidenceComplete(
  shouldFollowup: boolean,
  count: number,
  followups: readonly { question: string; hint: string }[],
): boolean {
  return !shouldFollowup || (count > 0 && followups.length === count && followups.every((f) => Boolean(f.question.trim()) && Boolean(f.hint.trim())));
}

export function promptEvidence(source: string, version: string, content: string, temperature: number, outputContract?: "gate-evidence-v1" | "gate-evidence-v2") {
  return { source, version, contentHash: createHash("sha256").update(content, "utf8").digest("hex"), temperature, runtimeContract: buildRuntimeContract(REQUEST_MODEL, temperature), ...(outputContract ? { outputContract } : {}) };
}

export function matchingPromptEvidence(actual: unknown, expected: ReturnType<typeof promptEvidence>): boolean {
  if (typeof actual !== "object" || actual === null) return false;
  const value = actual as Record<string, unknown>;
  const runtime = value.runtimeContract;
  if (typeof runtime !== "object" || runtime === null || Array.isArray(runtime)) return false;
  const runtimeValue = runtime as Record<string, unknown>;
  const expectedRuntime = expected.runtimeContract;
  return value.outputContract === expected.outputContract && value.source === expected.source && value.version === expected.version && value.contentHash === expected.contentHash && value.temperature === expected.temperature
    && (Object.keys(expectedRuntime) as (keyof typeof expectedRuntime)[]).every((key) => runtimeValue[key] === expectedRuntime[key]);
}
