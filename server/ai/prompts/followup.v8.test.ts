import { expect, it } from "vitest";
import { FOLLOWUP_EXAMPLE_SKIP, FOLLOWUP_EXAMPLE_FOLLOWUP, FOLLOWUP_PROMPT_V8 } from "./followup.v8";
import { validateFollowupEvidence } from "../followup-evidence";
const input={mainQuestion:"请判断数据变化原因",firstAnswer:"目前数据不足以确认原因",primaryDimension:"分析",rubric:{dimensions:{分析:["请说明判断依据"]},forbidden_leaks:[]}};
it("provides two internally consistent illustrative protocol examples", () => {
  const skipInput={...input,mainQuestion:"信息不足时请给下一步",firstAnswer:"当前资料尚不充分，下一步核对留存数据"};
  expect(validateFollowupEvidence(FOLLOWUP_EXAMPLE_SKIP,skipInput).shouldFollowup).toBe(false);
  expect(validateFollowupEvidence(FOLLOWUP_EXAMPLE_FOLLOWUP,input).followups).toHaveLength(1);
  expect(FOLLOWUP_PROMPT_V8.system).toContain(FOLLOWUP_EXAMPLE_SKIP);
  expect(FOLLOWUP_PROMPT_V8.system).toContain(FOLLOWUP_EXAMPLE_FOLLOWUP);
});
