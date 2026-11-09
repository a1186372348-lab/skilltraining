import { describe, expect, it } from "vitest";
import { serializePromptContent } from "./registry";
import { parseTrustedPrompt } from "./output-contract";

describe("trusted prompt output contracts", () => {
  it("preserves legacy canonical bytes and keeps the strict field", () => {
    expect(serializePromptContent({ system: "s", user: "u" })).toBe('{"system":"s","user":"u"}');
    expect(serializePromptContent({ system: "s", user: "u", outputContract: "gate-evidence-v1" })).toContain('"outputContract":"gate-evidence-v1"');
  });
  it("fails closed for missing, unknown and mismatched contract", () => {
    expect(() => parseTrustedPrompt("followup", "v8", '{"system":"s","user":"u"}')).toThrow();
    expect(() => parseTrustedPrompt("followup", "v7", '{"system":"s","user":"u","outputContract":"gate-evidence-v1"}')).toThrow();
    expect(() => parseTrustedPrompt("followup", "v8", '{"system":"s","user":"u","outputContract":"unknown"}')).toThrow();
  });
  it("keeps unknown historical versions without a field legacy", () => {
    expect(parseTrustedPrompt("followup", "historical", '{"system":"s","user":"u"}')).toEqual({system:"s",user:"u"});
  });
});

it("rejects strict source content whose own hash or canonical bytes do not match", () => {
  const strict='{"system":"s","user":"u","outputContract":"gate-evidence-v1"}';
  expect(() => parseTrustedPrompt("followup","v8",strict,"not-its-hash")).toThrow();
  expect(() => parseTrustedPrompt("followup","v8",'{ "system":"s","user":"u","outputContract":"gate-evidence-v1" }')).toThrow();
});

it("rejects explicitly invalid template protocol instead of dropping it", () => {
  expect(serializePromptContent({system:"s",user:"u",outputContract:undefined})).toBe('{"system":"s","user":"u"}');
  expect(() => serializePromptContent({system:"s",user:"u",outputContract:"other"} as never)).toThrow();
});

it("rejects null, empty, wrong type and unregistered declared protocols", () => {
  for (const value of [null,"",7,"other"]) {
    expect(() => parseTrustedPrompt("followup","v8",JSON.stringify({system:"s",user:"u",outputContract:value}))).toThrow();
  }
  expect(() => parseTrustedPrompt("other","v8",'{"system":"s","user":"u","outputContract":"gate-evidence-v1"}')).toThrow();
});


it("binds v9 exclusively to its v2 contract", () => {
  const v2=serializePromptContent({system:"s",user:"u",outputContract:"gate-evidence-v2"});
  expect(parseTrustedPrompt("followup","v9",v2)).toMatchObject({outputContract:"gate-evidence-v2"});
  expect(() => parseTrustedPrompt("followup","v8",v2)).toThrow();
  expect(() => parseTrustedPrompt("followup","v9",'{"system":"s","user":"u"}')).toThrow();
  expect(() => parseTrustedPrompt("followup","v9",v2,"bad")).toThrow();
});


it("rejects v9 malformed, v1 mismatch, and unknown version declarations", () => {
 const v1=serializePromptContent({system:"s",user:"u",outputContract:"gate-evidence-v1"});
 const v2=serializePromptContent({system:"s",user:"u",outputContract:"gate-evidence-v2"});
 expect(() => parseTrustedPrompt("followup","v9",v1)).toThrow();
 expect(() => parseTrustedPrompt("followup","v9","invalid")).toThrow();
 expect(() => parseTrustedPrompt("followup","v11",v2)).toThrow();
 expect(() => parseTrustedPrompt("followup","v9",` ${v2}`)).toThrow();
});


it.each(["constructor", "toString", "__proto__"])("keeps inherited key %s legacy and rejects protocol declarations", (version) => {
 expect(parseTrustedPrompt("followup",version,'{"system":"s","user":"u"}')).toEqual({system:"s",user:"u"});
 const strict=serializePromptContent({system:"s",user:"u",outputContract:"gate-evidence-v2"});
 expect(() => parseTrustedPrompt("followup",version,strict)).toThrow();
});

