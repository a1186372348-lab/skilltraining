import { describe, expect, it } from "vitest";
import { followupEvidenceComplete, matchingPromptEvidence, promptEvidence } from "./regression-evidence";

describe("回归证据", () => {
  it("有追问但缺全文时阻断，跳过样本允许无全文", () => {
    expect(followupEvidenceComplete(true, 2, [])).toBe(false);
    expect(followupEvidenceComplete(true, 2, [{ question: "q", hint: "h" }])).toBe(false);
    expect(followupEvidenceComplete(false, 0, [])).toBe(true);
    expect(followupEvidenceComplete(true, 1, [{ question: "q", hint: "h" }])).toBe(true);
  });
  it("按实际内容计算哈希并记录来源版本与温度", () => {
    expect(promptEvidence("database", "v1", "abc", 0.3)).toMatchObject({
      source: "database", version: "v1", contentHash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", temperature: 0.3,
    });
  });
});

it("缓存来源必须与实际使用的提示词一致", async () => {
  const { matchingPromptEvidence } = await import("./regression-evidence");
  const expected = promptEvidence("database", "v1", "abc", 0.3);
  expect(matchingPromptEvidence(undefined, expected)).toBe(false);
  expect(matchingPromptEvidence({ ...expected, temperature: 0.2 }, expected)).toBe(false);
  expect(matchingPromptEvidence(expected, expected)).toBe(true);
});

it("旧版证据与任意运行契约差异不能复用", async () => {
  const { matchingPromptEvidence } = await import("./regression-evidence");
  const expected = promptEvidence("database", "v1", "abc", 0.2);
  expect(matchingPromptEvidence({ source: expected.source, version: expected.version, contentHash: expected.contentHash, temperature: 0.2 }, expected)).toBe(false);
  expect(matchingPromptEvidence({ ...expected, runtimeContract: { ...expected.runtimeContract, maxTokens: 2048 } }, expected)).toBe(false);
});

it("运行契约任何字段差异及缺失均不得复用", async () => {
  const { matchingPromptEvidence } = await import("./regression-evidence");
  const expected = promptEvidence("database", "v1", "abc", 0.2);
  for (const key of Object.keys(expected.runtimeContract)) {
    expect(matchingPromptEvidence({ ...expected, runtimeContract: { ...expected.runtimeContract, [key]: "different" } }, expected)).toBe(false);
  }
  expect(matchingPromptEvidence(expected, expected)).toBe(true);
});

it("binds strict output protocol to prompt cache evidence", () => {
  const strict=promptEvidence("database","v8",'{"system":"x","user":"y","outputContract":"gate-evidence-v1"}',0.2,"gate-evidence-v1");
  expect(matchingPromptEvidence(strict,strict)).toBe(true);
  const legacy={...strict}; delete legacy.outputContract;
  expect(matchingPromptEvidence(legacy,strict)).toBe(false);
});


it("binds file v9 evidence to its protocol, hash and source", () => {
 const expected=promptEvidence("file","v9","candidate",0.2,"gate-evidence-v2");
 expect(matchingPromptEvidence(expected,expected)).toBe(true);
 expect(matchingPromptEvidence({...expected,source:"database"},expected)).toBe(false);
 expect(matchingPromptEvidence({...expected,outputContract:"gate-evidence-v1"},expected)).toBe(false);
 expect(matchingPromptEvidence({...expected,contentHash:"different"},expected)).toBe(false);
});
