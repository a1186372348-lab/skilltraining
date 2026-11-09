import { describe, expect, it } from "vitest";
import { resolveFilePrompt, validatePromptSource } from "./regression-file-prompt";

describe("受限文件候选", () => {
  it("仅允许 followup v9 文件候选", () => {
    expect(validatePromptSource("file", "followup", "v9")).toBe("file");
    expect(validatePromptSource("file", "followup", "v9")).toBe("file");
    expect(validatePromptSource(undefined, "scoring", undefined)).toBe("database");
    expect(validatePromptSource("database", "followup", "v9")).toBe("database");
    for (const args of [["file", "scoring", "v9"], ["file", "followup", "v8"], ["file", "followup", undefined], ["other", "followup", "v9"]] as const) {
      expect(() => validatePromptSource(args[0], args[1], args[2])).toThrow();
    }
  });
  it("序列化可信 v9 模板并记录真实内容证据", () => {
    const resolved = resolveFilePrompt();
    expect(resolved.id).toBeNull();
    expect(resolved.templates.outputContract).toBe("gate-evidence-v2");
    expect(resolved.evidence).toMatchObject({ source: "file", version: "v9", outputContract: "gate-evidence-v2" });
    expect(resolved.evidence.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

it("resolves explicit v10 and rejects unknown file versions", () => {
  expect(validatePromptSource("file", "followup", "v10")).toBe("file");
  expect(resolveFilePrompt("v10")).toMatchObject({version:"v10", templates:{promptVersion:"v10"}, evidence:{version:"v10", outputContract:"gate-evidence-v2"}});
  expect(() => resolveFilePrompt("unknown")).toThrow();
});
