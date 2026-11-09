import { FOLLOWUP_PROMPT_V10 } from "../../server/ai/prompts/followup.v10.ts";
import { FOLLOWUP_PROMPT_V9 } from "../../server/ai/prompts/followup.v9.ts";
import { parseTrustedPrompt } from "../../server/ai/prompts/output-contract.ts";
import { serializePromptContent } from "../../server/ai/prompts/registry.ts";
import { promptEvidence } from "./regression-evidence.ts";

export function validatePromptSource(source: string | undefined, suite: string, version: string | undefined): "file" | "database" {
  if (source === undefined || source === "database") return "database";
  if (source !== "file" || suite !== "followup" || !(["v9", "v10"].includes(version ?? ""))) {
    throw new Error("--prompt-source file 仅支持 --suite followup --version v9 或 v10；来源仅支持 file 或 database");
  }
  return "file";
}

export function resolveFilePrompt(version: string = "v9") {
  if (version !== "v9" && version !== "v10") throw new Error("未知文件候选版本");
  const content = serializePromptContent(version === "v9" ? FOLLOWUP_PROMPT_V9 : FOLLOWUP_PROMPT_V10);
  const parsed = parseTrustedPrompt("followup", version, content);
  if (!parsed || parsed.outputContract !== "gate-evidence-v2") throw new Error("文件候选协议无效");
  return {
    id: null,
    version,
    templates: { ...parsed, promptVersion: version, promptSource: "file" as const },
    evidence: promptEvidence("file", version, content, 0.2, parsed.outputContract),
  };
}
