import { FOLLOWUP_PROMPT_V9, FOLLOWUP_V9_EXAMPLE_NONMATERIAL } from "./followup.v9.ts";

export const FOLLOWUP_V10_EXAMPLE_NONMATERIAL = JSON.stringify({
  should_followup: false,
  reason: "已有下一步，背景细节可反馈",
  checks: [
    { id: "c1", group: "deliverable", rule: 1, status: "met", material: false, finding: "已给出下一步", refs: [{ source: "answer", quote: "下一步核对留存数据" }] },
    { id: "c2", group: "deliverable", rule: 1, status: "missing", material: false, finding: "未补充背景细节", refs: [{ source: "question", quote: "可补充背景细节" }] },
    { id: "c3", group: "core_claim", rule: 2, status: "not_applicable", material: false, finding: "暂未断言", refs: [{ source: "answer", quote: "当前资料尚不充分" }] },
  ],
  followups: [],
});

export const FOLLOWUP_PROMPT_V10 = {
  ...FOLLOWUP_PROMPT_V9,
  version: "v10",
  system: `${FOLLOWUP_PROMPT_V9.system.replace("非重大缺项格式示例的题目是“请判断变化并补充背景”，首答是“我认为变化来自季节波动”；仅展示数据结构，不代表任何类似判断一定放行：\n" + FOLLOWUP_V9_EXAMPLE_NONMATERIAL, "非重大缺项格式示例的题目是“信息不足时请给下一步，可补充背景细节”，首答是“当前资料尚不充分，下一步核对留存数据”：\n" + FOLLOWUP_V10_EXAMPLE_NONMATERIAL)}\n\n针对核心判断，找出承载核心结论的关键因果前提，并逐一核对其证据地位。若未获支持的前提被当作已成立的依据且实质影响核心判断，应针对该前提追问；结尾的总体不确定性不能代替这一检查。core_claim 核对须包含关键前提及首答对应原文引用。补答后以推断是否实际收束为准：区分事实与解释，说明可行的区分方法并相应调整核心判断；仅添加“可能”而继续把前提当成已证实依据不足以停问。不要求完整因果链实证，不索要题目材料外的实际数据。仅输出有限最终核对，不输出隐藏思维链。`,
} as const;
