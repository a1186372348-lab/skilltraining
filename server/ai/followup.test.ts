import { describe, expect, it, vi } from "vitest";

import type { AiClient } from "./client";
import { FollowupGenerationError, buildFollowupMessages, generateFollowups } from "./followup";

// 追问闸门（T35 / D37）：同一次 AI 调用先判定「值不值得追问」（should_followup），
// 值得才产出 1~2 问 + 每问预生成提示（D22）；不值得时 followups 为空数组、
// reason（中文一句话）由服务层落库审计。AI 调用以契约 mock（注入假 client），禁止真实出网。

const rubric = {
  dimensions: {
    用户理解: ["区分两类任务的差异", "识别写代码之外的时间消耗", "指出人机关系变化"],
    产品取舍: ["指出至少两项代价", "说明缓释设计", "判断分层共存"],
  },
  forbidden_leaks: ["「补全省按键、Agent 省任务」的价值对比结论", "具体缓释设计清单"],
};

function fakeClient(content: string): AiClient {
  return { chatCompletion: vi.fn().mockResolvedValue({ content, model: "deepseek-flash", usage: null }) };
}

describe("buildFollowupMessages：追问闸门 prompt 硬性约束（T35 / D37）", () => {
  it("包含主问题、首答、Rubric 上下文与禁止泄露点约束", () => {
    const messages = buildFollowupMessages({
      mainQuestion: "为什么是质变？",
      firstAnswer: "我觉得是效率提升。",
      rubric,
      primaryDimension: "用户理解",
    });
    const text = messages.map((m) => m.content).join("\n");
    expect(text).toContain("为什么是质变？");
    expect(text).toContain("我觉得是效率提升。");
    expect(text).toContain("「补全省按键、Agent 省任务」的价值对比结论"); // forbidden_leaks 显式列出
    expect(text).toMatch(/不得.*(泄露|透露)/); // 硬性不泄露约束
    expect(messages[0].role).toBe("system");
  });

  it("先判定后生成：锚定主测维度，判定标准从紧（宁可多追问，不可放过）", () => {
    const messages = buildFollowupMessages({
      mainQuestion: "主问题？",
      firstAnswer: "首答。",
      rubric,
      primaryDimension: "用户理解",
    });
    const text = messages.map((m) => m.content).join("\n");
    expect(text).toContain("用户理解"); // 主测维度锚点入 prompt
    expect(text).toContain("should_followup");
    expect(text).toMatch(/证据链/); // 判定标准：证据链完整
    expect(text).toMatch(/宁可多追问/); // 从紧表述（放水比过严更危险）
  });

  it("reason 约束：中文一句话、不复述评分细则原文（仅落库审计）", () => {
    const messages = buildFollowupMessages({
      mainQuestion: "主问题？",
      firstAnswer: "首答。",
      rubric,
      primaryDimension: "用户理解",
    });
    const text = messages.map((m) => m.content).join("\n");
    expect(text).toContain("reason");
    expect(text).toMatch(/中文一句话/);
    expect(text).toMatch(/不得.*(复述|泄露).*评分细则|评分细则.*(原文|复述)/);
  });

  it("要求为每条追问附带一条提示（思考支架），且提示同受防泄露约束", () => {
    const messages = buildFollowupMessages({
      mainQuestion: "主问题？",
      firstAnswer: "首答。",
      rubric,
      primaryDimension: "用户理解",
    });
    const text = messages.map((m) => m.content).join("\n");
    expect(text).toContain('"question"');
    expect(text).toContain('"hint"');
    // 提示是思考支架：引导方向，不泄露 Rubric 要点与禁止泄露点
    expect(text).toMatch(/提示.*(引导|方向|思考)/);
  });

  it("主测维度缺失时降级为通用表述（防御，不崩）", () => {
    const messages = buildFollowupMessages({
      mainQuestion: "主问题？",
      firstAnswer: "首答。",
      rubric,
    });
    const text = messages.map((m) => m.content).join("\n");
    expect(text).toContain("should_followup");
    expect(text).toMatch(/训练重点|主测维度/);
  });
});

describe("generateFollowups（T35 / D37 追问闸门输出契约）", () => {
  const input = { mainQuestion: "主问题", firstAnswer: "首答", rubric, primaryDimension: "用户理解" };

  it("判定需要追问：shouldFollowup=true，返回 1~2 条带提示追问与判定理由", async () => {
    const client = fakeClient(
      '{"should_followup": true, "reason": "核心主张缺少证据支撑", "followups": [{"question": "证据是什么？", "hint": "想想可衡量的指标"}, {"question": "反方怎么反驳？", "hint": "站在反方立场找最强论据"}]}',
    );
    const result = await generateFollowups(input, { client });
    expect(result).toEqual({
      shouldFollowup: true,
      reason: "核心主张缺少证据支撑",
      followups: [
        { question: "证据是什么？", hint: "想想可衡量的指标" },
        { question: "反方怎么反驳？", hint: "站在反方立场找最强论据" },
      ],
    });
  });

  it("闸门跳过：should_followup=false → followups 为空数组，reason 保留供落库审计", async () => {
    const client = fakeClient(
      '{"should_followup": false, "reason": "主测维度要点覆盖完整，证据链闭环", "followups": []}',
    );
    const result = await generateFollowups(input, { client });
    expect(result).toEqual({
      shouldFollowup: false,
      reason: "主测维度要点覆盖完整，证据链闭环",
      followups: [],
    });
  });

  it("闸门结论优先：should_followup=false 即便误附追问也一律丢弃", async () => {
    const client = fakeClient(
      '{"should_followup": false, "reason": "无需追问", "followups": [{"question": "多嘴的追问", "hint": "h"}]}',
    );
    const result = await generateFollowups(input, { client });
    expect(result.shouldFollowup).toBe(false);
    expect(result.followups).toEqual([]);
  });

  it("reason 缺失或为空：兜底占位文案（落库审计不为空串）", async () => {
    const skip = await generateFollowups(input, {
      client: fakeClient('{"should_followup": false, "followups": []}'),
    });
    expect(skip.reason.trim().length).toBeGreaterThan(0);
    const ask = await generateFollowups(input, {
      client: fakeClient('{"should_followup": true, "followups": [{"question": "q1", "hint": "h1"}]}'),
    });
    expect(ask.reason.trim().length).toBeGreaterThan(0);
  });

  it("1 条追问也合法（D6：1~2 轮）", async () => {
    const client = fakeClient(
      '{"should_followup": true, "reason": "结论句缺失", "followups": [{"question": "你的结论句是什么？", "hint": "提示"}]}',
    );
    const result = await generateFollowups(input, { client });
    expect(result.followups).toHaveLength(1);
  });

  it("超过 2 条截断为 2 条（轮次硬上限，R2）", async () => {
    const client = fakeClient(
      '{"should_followup": true, "reason": "r", "followups": [{"question": "q1", "hint": "h1"}, {"question": "q2", "hint": "h2"}, {"question": "q3", "hint": "h3"}]}',
    );
    const result = await generateFollowups(input, { client });
    expect(result.followups).toHaveLength(2);
    expect(result.followups.map((f) => f.question)).toEqual(["q1", "q2"]);
  });

  it("hint 缺失或为空时降级为空串，不因此丢弃追问", async () => {
    const client = fakeClient(
      '{"should_followup": true, "reason": "r", "followups": [{"question": "q1"}, {"question": "q2", "hint": ""}, {"question": "q3", "hint": "  "}]}',
    );
    const result = await generateFollowups(input, { client });
    expect(result.followups).toEqual([
      { question: "q1", hint: "" },
      { question: "q2", hint: "" },
    ]);
  });

  it("should_followup 缺省但给出有效追问：按需要追问处理（向后兼容旧输出）", async () => {
    const client = fakeClient('{"followups": [{"question": "q1", "hint": "h1"}, "q2"]}');
    const result = await generateFollowups(input, { client });
    expect(result.shouldFollowup).toBe(true);
    expect(result.followups).toEqual([
      { question: "q1", hint: "h1" },
      { question: "q2", hint: "" },
    ]);
  });

  it("容忍 ```json 代码块包裹", async () => {
    const client = fakeClient(
      '```json\n{"should_followup": true, "reason": "r", "followups": [{"question": "q1", "hint": "h1"}]}\n```',
    );
    const result = await generateFollowups(input, { client });
    expect(result.followups).toEqual([{ question: "q1", hint: "h1" }]);
  });

  it("追问文本为空的条目丢弃；should_followup=true 但有效追问为空：抛错（按生成失败处理，可重试）", async () => {
    const client = fakeClient(
      '{"should_followup": true, "reason": "r", "followups": [{"question": "", "hint": "h"}, {"question": "q1", "hint": "h1"}]}',
    );
    const result = await generateFollowups(input, { client });
    expect(result.followups).toEqual([{ question: "q1", hint: "h1" }]);
    // 判定追问却一条有效追问都没有：输出自相矛盾，按生成失败抛错（服务层落失败空数组，可重试）
    await expect(
      generateFollowups(input, {
        client: fakeClient('{"should_followup": true, "reason": "r", "followups": []}'),
      }),
    ).rejects.toBeInstanceOf(FollowupGenerationError);
    await expect(
      generateFollowups(input, {
        client: fakeClient('{"should_followup": true, "reason": "r", "followups": [{"hint": "只有提示没有追问"}]}'),
      }),
    ).rejects.toBeInstanceOf(FollowupGenerationError);
  });

  it("输出非 JSON / 缺 followups 数组且未判定跳过：抛 FollowupGenerationError（服务层兜底跳过追问）", async () => {
    await expect(generateFollowups(input, { client: fakeClient("不是 JSON") })).rejects.toBeInstanceOf(
      FollowupGenerationError,
    );
    await expect(
      generateFollowups(input, { client: fakeClient('{"followups": []}') }),
    ).rejects.toBeInstanceOf(FollowupGenerationError);
    await expect(
      generateFollowups(input, { client: fakeClient('{"reason": "只有理由没有结论"}') }),
    ).rejects.toBeInstanceOf(FollowupGenerationError);
  });

  it("调用参数：低 temperature + json_object 结构化输出 + 模型上下文", async () => {
    const client = fakeClient(
      '{"should_followup": true, "reason": "r", "followups": [{"question": "q1", "hint": "h1"}]}',
    );
    await generateFollowups(input, { client });
    expect(client.chatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        responseFormat: { type: "json_object" },
        temperature: expect.any(Number),
      }),
    );
    const { temperature } = (client.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      temperature: number;
    };
    expect(temperature).toBeLessThanOrEqual(0.3);
  });
});
