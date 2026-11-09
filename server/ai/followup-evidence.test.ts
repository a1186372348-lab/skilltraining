import { describe, expect, it, vi } from "vitest";
import { validateFollowupEvidence } from "./followup-evidence";
import { generateFollowups } from "./followup";

const input = { mainQuestion: "请解释业务问题", firstAnswer: "我认为情况尚不明确", primaryDimension: "分析", rubric: { dimensions: { 分析: ["说明业务问题原因"] }, forbidden_leaks: ["禁止透露答案细节"] } };
const valid = { should_followup:false, reason:"现有回答保留不确定性", checks:[{id:"c1",group:"deliverable",rule:1,status:"met",material:false,finding:"已回应",refs:[{source:"answer",quote:"情况尚不明确"}]},{id:"c2",group:"core_claim",rule:2,status:"not_applicable",material:false,finding:"未断言",refs:[{source:"answer",quote:"情况尚不明确"}]}],followups:[] };
describe("strict followup evidence", () => {
  it("accepts grounded checks but strips them from the result", () => {
    expect(validateFollowupEvidence(JSON.stringify(valid),input)).toEqual({shouldFollowup:false,reason:valid.reason,followups:[]});
  });
  it("rejects fabricated citations and cannot hide required defects", () => {
    const fabricated=structuredClone(valid); fabricated.checks[0].refs[0].quote="不存在的引文";
    expect(() => validateFollowupEvidence(JSON.stringify(fabricated),input)).toThrow();
    const concealed=structuredClone(valid); concealed.checks[0].status="missing"; concealed.checks[0].refs[0]={source:"question",quote:"解释业务问题"};
    expect(() => validateFollowupEvidence(JSON.stringify(concealed),input)).toThrow();
  });
  it("rejects invalid group-rule association and missing groups", () => {
    const mismatch=structuredClone(valid); mismatch.checks[0].rule=2;
    expect(() => validateFollowupEvidence(JSON.stringify(mismatch),input)).toThrow();
    expect(() => validateFollowupEvidence(JSON.stringify({...valid,checks:valid.checks.slice(0,1)}),input)).toThrow();
  });
  it("rejects missing primary dimension before calling the model", async () => {
    const chatCompletion=vi.fn();
    await expect(generateFollowups({...input,primaryDimension:undefined},{client:{chatCompletion} as never,templates:{system:"s",user:"u",outputContract:"gate-evidence-v1"}})).rejects.toThrow();
    expect(chatCompletion).not.toHaveBeenCalled();
  });
});

it("rejects untrusted output contract", async () => {
  const chatCompletion=vi.fn();
  await expect(generateFollowups(input,{client:{chatCompletion} as never,templates:{system:"s",user:"u",outputContract:"invalid"} as never})).rejects.toThrow();
  expect(chatCompletion).not.toHaveBeenCalled();
});

it("rejects private rubric excerpts in the public result", () => {
  const leaked=structuredClone(valid);
  leaked.reason="说明业务问题原因";
  expect(() => validateFollowupEvidence(JSON.stringify(leaked),input)).toThrow();
});

it("accepts a grounded uncertainty expression without a keyword whitelist", () => {
  const alternate={...input,firstAnswer:"现阶段暂且悬置判断"};
  const output=structuredClone(valid);
  output.checks[0].refs[0].quote="暂且悬置判断";
  output.checks[1].refs[0].quote="暂且悬置判断";
  expect(validateFollowupEvidence(JSON.stringify(output),alternate).shouldFollowup).toBe(false);
});

it("accepts one material-linked followup without forcing every material check to be covered", () => {
  const checks=[{id:"c1",group:"deliverable",rule:1,status:"missing",material:true,finding:"缺少交付",refs:[{source:"question",quote:"解释业务问题"}]},{id:"c2",group:"core_claim",rule:4,status:"unsupported",material:true,finding:"未经证实",refs:[{source:"answer",quote:"情况尚不明确"}]}];
  const output={should_followup:true,reason:"核心交付存在缺口",checks,followups:[{question:"你会先如何判断？",hint:"想想依据",check_ids:["c1"]}]};
  expect(validateFollowupEvidence(JSON.stringify(output),input).followups).toEqual([{question:"你会先如何判断？",hint:"想想依据"}]);
  output.followups[0].check_ids=["c3"];
  expect(() => validateFollowupEvidence(JSON.stringify(output),input)).toThrow();
});

it("rejects duplicates, extra fields and text exceeding Unicode codepoint bounds", () => {
  const duplicate=structuredClone(valid); duplicate.checks[1].id="c1";
  expect(() => validateFollowupEvidence(JSON.stringify(duplicate),input)).toThrow();
  expect(() => validateFollowupEvidence(JSON.stringify({...valid, extra:"private"}),input)).toThrow();
  expect(() => validateFollowupEvidence(JSON.stringify({...valid, reason:"😀".repeat(121)}),input)).toThrow();
});

it("reports fixed failures without repeating private output", () => {
  try { validateFollowupEvidence('{"reason":"secret-sentinel"}',input); }
  catch (error) { expect(String(error)).not.toContain("secret-sentinel"); return; }
  throw new Error("expected failure");
});

it("allows ordinary terms from a short rubric citation without leaking the full private point", () => {
  const example={...input,mainQuestion:"请判断目标用户",firstAnswer:"目前用户暂未确定",rubric:{dimensions:{分析:["请识别目标用户并说明场景"]},forbidden_leaks:[]}};
  const output={should_followup:true,reason:"需澄清判断范围",checks:[{id:"c1",group:"deliverable",rule:1,status:"missing",material:true,finding:"缺少交付",refs:[{source:"primary_rubric",quote:"目标用户"}]},{id:"c2",group:"core_claim",rule:2,status:"not_applicable",material:false,finding:"暂未断言",refs:[{source:"answer",quote:"用户暂未确定"}]}],followups:[{question:"你界定的目标用户是什么？",hint:"想想范围",check_ids:["c1"]}]};
  expect(validateFollowupEvidence(JSON.stringify(output),example).followups).toHaveLength(1);
});


it("v2 retains nonmaterial defects on skip while v1 rejects them", () => {
  const output={...valid,checks:[{...valid.checks[0],status:"missing",refs:[{source:"question",quote:"解释业务问题"}]},{...valid.checks[1],status:"unsupported",refs:[{source:"answer",quote:"情况尚不明确"}]}]};
  expect(() => validateFollowupEvidence(JSON.stringify(output),input)).toThrow();
  expect(validateFollowupEvidence(JSON.stringify(output),input,"gate-evidence-v2").shouldFollowup).toBe(false);
  expect(() => validateFollowupEvidence(JSON.stringify({...output,checks:output.checks.slice(0,1)}),input,"gate-evidence-v2")).toThrow();
  const fake=structuredClone(output); fake.checks[0].refs[0].quote="并不存在的原文";
  expect(() => validateFollowupEvidence(JSON.stringify(fake),input,"gate-evidence-v2")).toThrow();
});


it("v2 permits only material-linked followups and preserves leak checks", () => {
 const checks=[{id:"c1",group:"deliverable",rule:1,status:"missing",material:false,finding:"次要缺项",refs:[{source:"question",quote:"解释业务问题"}]},{id:"c2",group:"core_claim",rule:4,status:"unsupported",material:true,finding:"关键缺口",refs:[{source:"answer",quote:"情况尚不明确"}]}];
 const output={should_followup:true,reason:"需要澄清关键判断",checks,followups:[{question:"你的判断依据是什么？",hint:"想想已有信息",check_ids:["c2"]}]};
 expect(validateFollowupEvidence(JSON.stringify(output),input,"gate-evidence-v2").shouldFollowup).toBe(true);
 expect(() => validateFollowupEvidence(JSON.stringify({...output,followups:[{...output.followups[0],check_ids:["c1"]}]}),input,"gate-evidence-v2")).toThrow();
 expect(() => validateFollowupEvidence(JSON.stringify({...output,reason:"说明业务问题原因"}),input,"gate-evidence-v2")).toThrow();
 expect(() => validateFollowupEvidence(JSON.stringify({...output,should_followup:false,followups:[]}),input,"gate-evidence-v2")).toThrow();
});

it("generates using v2 only when supplied by trusted templates", async () => {
 const output={...valid,checks:[{...valid.checks[0],status:"missing",refs:[{source:"question",quote:"解释业务问题"}]},valid.checks[1]]};
 const chatCompletion=vi.fn().mockResolvedValue({content:JSON.stringify(output)});
 await expect(generateFollowups(input,{client:{chatCompletion} as never,templates:{system:"s",user:"u",outputContract:"gate-evidence-v2"}})).resolves.toMatchObject({shouldFollowup:false});
});
