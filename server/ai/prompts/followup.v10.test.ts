import { describe, expect, it } from "vitest";
import { FOLLOWUP_PROMPT_V10 } from "./followup.v10";
import { parseTrustedPrompt } from "./output-contract";
import { serializePromptContent } from "./registry";

describe("v10 candidate", () => {
  it("binds v2 and asks for causal premise evidence and actual closure", () => {
    expect(parseTrustedPrompt("followup", "v10", serializePromptContent(FOLLOWUP_PROMPT_V10))?.outputContract).toBe("gate-evidence-v2");
    expect(FOLLOWUP_PROMPT_V10.system).toContain("关键因果前提");
    expect(FOLLOWUP_PROMPT_V10.system).toContain("实际收束");
    expect(() => parseTrustedPrompt("followup", "v10", JSON.stringify({system:"s",user:"u",outputContract:"gate-evidence-v1"}))).toThrow();
  });
});

it("validates the consistent fictional nonmaterial example through the v10 generation chain", async () => {
  const { FOLLOWUP_V10_EXAMPLE_NONMATERIAL } = await import("./followup.v10");
  const { validateFollowupEvidence } = await import("../followup-evidence");
  const { buildFollowupMessages, generateFollowups } = await import("../followup");
  const input = { mainQuestion:"信息不足时请给下一步，可补充背景细节", firstAnswer:"当前资料尚不充分，下一步核对留存数据", primaryDimension:"分析", rubric:{dimensions:{分析:["提出下一步"]},forbidden_leaks:[]} };
  expect(validateFollowupEvidence(FOLLOWUP_V10_EXAMPLE_NONMATERIAL,input,"gate-evidence-v2").shouldFollowup).toBe(false);
  expect(FOLLOWUP_PROMPT_V10.system).toContain(FOLLOWUP_V10_EXAMPLE_NONMATERIAL);
  expect(FOLLOWUP_PROMPT_V10.system).not.toContain("我认为变化来自季节波动");
  const { vi } = await import("vitest");
  const chatCompletion = vi.fn().mockResolvedValue({content:FOLLOWUP_V10_EXAMPLE_NONMATERIAL});
  await expect(generateFollowups(input,{client:{chatCompletion} as never,templates:FOLLOWUP_PROMPT_V10})).resolves.toMatchObject({shouldFollowup:false});
  expect(chatCompletion.mock.calls[0][0].messages).toEqual(buildFollowupMessages(input,FOLLOWUP_PROMPT_V10));
});
