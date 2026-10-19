import { describe, expect, it, vi } from "vitest";

import type { AiClient } from "./client";
import { FollowupGenerationError, buildFollowupMessages, generateFollowups } from "./followup";

// 追问生成：AI 调用以契约 mock（注入假 client），禁止真实出网。
// T19（D22）：同一次调用为每条追问附带一条预生成提示（思考支架），输出结构
// {"followups": [{"question": "...", "hint": "..."}]}。

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

describe("buildFollowupMessages：追问 prompt 硬性约束", () => {
  it("包含主问题、首答、Rubric 上下文与禁止泄露点约束", () => {
    const messages = buildFollowupMessages({
      mainQuestion: "为什么是质变？",
      firstAnswer: "我觉得是效率提升。",
      rubric,
    });
    const text = messages.map((m) => m.content).join("\n");
    expect(text).toContain("为什么是质变？");
    expect(text).toContain("我觉得是效率提升。");
    expect(text).toContain("「补全省按键、Agent 省任务」的价值对比结论"); // forbidden_leaks 显式列出
    expect(text).toMatch(/不得.*(泄露|透露)/); // 硬性不泄露约束
    expect(messages[0].role).toBe("system");
  });

  it("要求为每条追问附带一条提示（思考支架），且提示同受防泄露约束", () => {
    const messages = buildFollowupMessages({
      mainQuestion: "主问题？",
      firstAnswer: "首答。",
      rubric,
    });
    const text = messages.map((m) => m.content).join("\n");
    expect(text).toContain("提示"); // prompt 中出现提示要求
    expect(text).toContain('"question"');
    expect(text).toContain('"hint"');
    // 提示是思考支架：引导方向，不泄露 Rubric 要点与禁止泄露点
    expect(text).toMatch(/提示.*(引导|方向|思考)/);
  });
});

describe("generateFollowups", () => {
  const input = { mainQuestion: "主问题", firstAnswer: "首答", rubric };

  it("解析 JSON 输出，返回 1~2 条带提示的追问", async () => {
    const client = fakeClient(
      '{"followups": [{"question": "证据是什么？", "hint": "想想可衡量的指标"}, {"question": "反方怎么反驳？", "hint": "站在反方立场找最强论据"}]}',
    );
    const followups = await generateFollowups(input, { client });
    expect(followups).toEqual([
      { question: "证据是什么？", hint: "想想可衡量的指标" },
      { question: "反方怎么反驳？", hint: "站在反方立场找最强论据" },
    ]);
  });

  it("1 条追问也合法（D6：1~2 轮）", async () => {
    const client = fakeClient('{"followups": [{"question": "你的结论句是什么？", "hint": "提示"}]}');
    expect(await generateFollowups(input, { client })).toHaveLength(1);
  });

  it("超过 2 条截断为 2 条（轮次硬上限，R2）", async () => {
    const client = fakeClient(
      '{"followups": [{"question": "q1", "hint": "h1"}, {"question": "q2", "hint": "h2"}, {"question": "q3", "hint": "h3"}]}',
    );
    const followups = await generateFollowups(input, { client });
    expect(followups).toHaveLength(2);
    expect(followups.map((f) => f.question)).toEqual(["q1", "q2"]);
  });

  it("hint 缺失或为空时降级为空串，不因此丢弃追问", async () => {
    const client = fakeClient(
      '{"followups": [{"question": "q1"}, {"question": "q2", "hint": ""}, {"question": "q3", "hint": "  "}]}',
    );
    const followups = await generateFollowups(input, { client });
    expect(followups).toEqual([
      { question: "q1", hint: "" },
      { question: "q2", hint: "" },
    ]);
  });

  it("兼容模型按旧结构输出纯字符串数组：提示降级为空串", async () => {
    const client = fakeClient('{"followups": ["q1", "q2"]}');
    expect(await generateFollowups(input, { client })).toEqual([
      { question: "q1", hint: "" },
      { question: "q2", hint: "" },
    ]);
  });

  it("容忍 ```json 代码块包裹", async () => {
    const client = fakeClient('```json\n{"followups": [{"question": "q1", "hint": "h1"}]}\n```');
    expect(await generateFollowups(input, { client })).toEqual([{ question: "q1", hint: "h1" }]);
  });

  it("追问文本为空的条目丢弃；全部为空时抛错", async () => {
    const client = fakeClient('{"followups": [{"question": "", "hint": "h"}, {"question": "q1", "hint": "h1"}]}');
    expect(await generateFollowups(input, { client })).toEqual([{ question: "q1", hint: "h1" }]);
    await expect(
      generateFollowups(input, { client: fakeClient('{"followups": [{"hint": "只有提示没有追问"}]}') }),
    ).rejects.toBeInstanceOf(FollowupGenerationError);
  });

  it("输出非 JSON / 空数组：抛 FollowupGenerationError（服务层兜底跳过追问）", async () => {
    await expect(generateFollowups(input, { client: fakeClient("不是 JSON") })).rejects.toBeInstanceOf(
      FollowupGenerationError,
    );
    await expect(
      generateFollowups(input, { client: fakeClient('{"followups": []}') }),
    ).rejects.toBeInstanceOf(FollowupGenerationError);
  });

  it("调用参数：低 temperature + json_object 结构化输出 + 模型上下文", async () => {
    const client = fakeClient('{"followups": [{"question": "q1", "hint": "h1"}]}');
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
