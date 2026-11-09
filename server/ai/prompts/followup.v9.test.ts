import { expect, it, vi } from "vitest";
import { FOLLOWUP_PROMPT_V9, FOLLOWUP_V9_EXAMPLE_SKIP, FOLLOWUP_V9_EXAMPLE_FOLLOWUP, FOLLOWUP_V9_EXAMPLE_NONMATERIAL } from "./followup.v9";
import { parseTrustedPrompt } from "./output-contract";
import { validateFollowupEvidence } from "../followup-evidence";
import { buildFollowupMessages, generateFollowups } from "../followup";
import { serializePromptContent } from "./registry";

it("registers a distinct grounded semantic candidate", () => {
 expect(FOLLOWUP_PROMPT_V9.version).toBe("v9");
 expect(FOLLOWUP_PROMPT_V9.outputContract).toBe("gate-evidence-v2");
 expect(FOLLOWUP_PROMPT_V9.system).toContain(FOLLOWUP_V9_EXAMPLE_SKIP);
 expect(FOLLOWUP_PROMPT_V9.system).toContain(FOLLOWUP_V9_EXAMPLE_FOLLOWUP);
 expect(parseTrustedPrompt("followup","v9",serializePromptContent(FOLLOWUP_PROMPT_V9))).toMatchObject({outputContract:"gate-evidence-v2"});
});


it("validates both fictional examples and dispatches the v9 result", async () => {
 const common={primaryDimension:"分析",rubric:{dimensions:{分析:["解释如何分析问题"]},forbidden_leaks:[]}};
 const skip={...common,mainQuestion:"信息不足时请给下一步",firstAnswer:"当前资料尚不充分，下一步核对留存数据"};
 const followup={...common,mainQuestion:"请判断数据变化原因",firstAnswer:"目前数据不足以确认原因"};
 expect(validateFollowupEvidence(FOLLOWUP_V9_EXAMPLE_SKIP,skip,"gate-evidence-v2").shouldFollowup).toBe(false);
 expect(validateFollowupEvidence(FOLLOWUP_V9_EXAMPLE_FOLLOWUP,followup,"gate-evidence-v2").shouldFollowup).toBe(true);
 const messages=buildFollowupMessages(skip,FOLLOWUP_PROMPT_V9);
 expect(messages[0].content).toContain(FOLLOWUP_V9_EXAMPLE_SKIP);
 expect(messages[1].content).toContain(skip.firstAnswer);
 const chatCompletion=vi.fn().mockResolvedValue({content:FOLLOWUP_V9_EXAMPLE_SKIP});
 await expect(generateFollowups(skip,{client:{chatCompletion} as never,templates:FOLLOWUP_PROMPT_V9})).resolves.toMatchObject({shouldFollowup:false});
 expect(chatCompletion.mock.calls[0][0].messages).toEqual(messages);
});


it("validates a fictional nonmaterial missing check on skip", () => {
 const input={mainQuestion:"请判断变化并补充背景",firstAnswer:"我认为变化来自季节波动",primaryDimension:"分析",rubric:{dimensions:{分析:["分析变化的主要原因"]},forbidden_leaks:[]}};
 expect(validateFollowupEvidence(FOLLOWUP_V9_EXAMPLE_NONMATERIAL,input,"gate-evidence-v2").shouldFollowup).toBe(false);
 expect(() => validateFollowupEvidence(FOLLOWUP_V9_EXAMPLE_NONMATERIAL,input,"gate-evidence-v1")).toThrow();
 expect(FOLLOWUP_PROMPT_V9.system).toContain(FOLLOWUP_V9_EXAMPLE_NONMATERIAL);
});
