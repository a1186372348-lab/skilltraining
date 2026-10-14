import { describe, expect, it, vi } from "vitest";

import type { MimoClient } from "@/server/ai/mimo-client";

import { ScoringError, SCORING_ERROR_CODES as CODES } from "./errors";
import {
  buildScoringMessages,
  parseScoringOutput,
  scoreWithRubric,
  type RubricScoringInput,
} from "./rubric-scorer";

// Rubric 评分调用：AI 以契约 mock（注入假 client），禁止真实出网。
// 对齐 server/ai/followup 的结构化输出范式（json_object + 低 temperature）。

const input: RubricScoringInput = {
  mainDimension: "用户理解",
  mainQuestion: "Cursor 的 Agent 模式为什么是质变？",
  rubricDimensions: {
    用户理解: ["区分两类任务的差异", "识别写代码之外的时间消耗", "指出人机关系变化"],
    产品取舍: ["指出至少两项代价", "说明缓释设计", "判断分层共存"],
  },
  firstAnswer: "首答：Agent 能自动写代码，效率更高。",
  followupQuestions: ["「效率更高」的衡量证据是什么？", "反方如何反驳？"],
  finalAnswer: "终答：Agent 接管了任务闭环，写代码只占工程师 30% 时间，其余环节被打通才是质变。",
};

const validOutput = JSON.stringify({
  dimensions: [
    { dimension: "用户理解", raw_score: 82, diagnosis: "终答引用「写代码只占 30% 时间」识别了任务差异。" },
    { dimension: "产品取舍", raw_score: 68, diagnosis: "提到分层共存，但未指出具体代价。" },
  ],
  top_issue: "终答中「其余环节被打通」没有给出任何一个具体环节的证据，应补一个可验证的例子。",
  next_focus: "下一步练「产品取舍」中识别代价并给出缓释设计的问题。",
});

function fakeClient(content: string): MimoClient {
  return {
    chatCompletion: vi.fn().mockResolvedValue({ content, model: "mimo-v2.6-pro", usage: null }),
  };
}

/** 捕获同步抛出的错误（供 toMatchObject 断言错误码） */
function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("buildScoringMessages：评分 prompt 分档锚定与评分纪律", () => {
  it("包含主问题、Rubric 各维度标准、首答/追问/终答全文", () => {
    const messages = buildScoringMessages(input);
    const text = messages.map((m) => m.content).join("\n");
    expect(text).toContain("Cursor 的 Agent 模式为什么是质变？");
    expect(text).toContain("区分两类任务的差异");
    expect(text).toContain("判断分层共存");
    expect(text).toContain("首答：Agent 能自动写代码，效率更高。");
    expect(text).toContain("「效率更高」的衡量证据是什么？");
    expect(text).toContain("终答：Agent 接管了任务闭环");
    expect(messages[0].role).toBe("system");
  });

  it("BR-7：硬性要求最需优化问题具体、可行动、引用答案证据，禁止泛泛结论", () => {
    const text = buildScoringMessages(input)
      .map((m) => m.content)
      .join("\n");
    expect(text).toMatch(/具体/);
    expect(text).toMatch(/可行动/);
    expect(text).toMatch(/引用|证据/);
    expect(text).toMatch(/禁止.*泛泛|泛泛.*禁止/);
  });

  it("BR-1：prompt 只出现能力标签覆盖的维度", () => {
    const text = buildScoringMessages(input)
      .map((m) => m.content)
      .join("\n");
    expect(text).toContain("用户理解");
    expect(text).toContain("产品取舍");
    expect(text).not.toContain("根因分析");
  });

  it("T33：system prompt 含六档分数锚定、立场中立与「暂缓判断」保护（抑制中间档压缩）", () => {
    const system = buildScoringMessages(input)[0];
    expect(system.role).toBe("system");
    expect(system.content).toContain("先定档、再定分");
    expect(system.content).toContain("90~100 优秀");
    expect(system.content).toContain("80~89 高质量");
    expect(system.content).toContain("0~39 低质量");
    expect(system.content).toContain("立场方向（支持/反对/暂缓/折中）不影响得分");
    expect(system.content).toContain("暂缓判断、条件式结论");
    expect(system.content).toContain("不得因存在任何缺项就跨档压低");
  });

  it("T33 R3：user 消息在主问题后、Rubric 前标注本题主测维度", () => {
    const user = buildScoringMessages(input)[1];
    expect(user.role).toBe("user");
    expect(user.content).toContain("本题主测维度：用户理解");
    expect(user.content.indexOf("本题主测维度：用户理解")).toBeLessThan(
      user.content.indexOf("【评分维度与 Rubric 标准】"),
    );
  });

  it("T33 R3：纪律 3 缺陷按维度归因、纪律 7 诊断与分数相互印证、纪律 9 top_issue 优先主测维度", () => {
    const system = buildScoringMessages(input)[0];
    expect(system.content).toContain("缺陷归因必须准确");
    expect(system.content).toContain("不得自行增设考点");
    expect(system.content).toContain("诊断与分数必须相互印证");
    expect(system.content).toContain("不得进入优秀档（90+）");
    expect(system.content).toContain("优先从主测维度的最关键缺陷中产生");
  });

  it("无追问时追问区明确标注「无」，不伪造对话", () => {
    const text = buildScoringMessages({ ...input, followupQuestions: [] })
      .map((m) => m.content)
      .join("\n");
    expect(text).toMatch(/无追问/);
  });
});

describe("parseScoringOutput：结构化输出解析与兜底", () => {
  const requested = ["用户理解", "产品取舍"];

  it("解析合法输出：按请求维度顺序返回分数与诊断", () => {
    const output = parseScoringOutput(validOutput, requested);
    expect(output.dimensions.map((d) => d.dimension)).toEqual(requested);
    expect(output.dimensions[0]).toMatchObject({ rawScore: 82 });
    expect(output.dimensions[1].diagnosis).toContain("未指出具体代价");
    expect(output.topIssue).toContain("具体环节的证据");
    expect(output.nextFocus).toContain("产品取舍");
  });

  it("容忍 ```json 代码块包裹", () => {
    const wrapped = `\`\`\`json\n${validOutput}\n\`\`\``;
    expect(parseScoringOutput(wrapped, requested).dimensions).toHaveLength(2);
  });

  it("忽略请求维度之外的多余维度", () => {
    const extra = JSON.stringify({
      dimensions: [
        { dimension: "根因分析", raw_score: 50, diagnosis: "多余维度" },
        { dimension: "用户理解", raw_score: 82, diagnosis: "诊断一" },
        { dimension: "产品取舍", raw_score: 68, diagnosis: "诊断二" },
      ],
      top_issue: "具体问题",
      next_focus: "下一步",
    });
    const output = parseScoringOutput(extra, requested);
    expect(output.dimensions.map((d) => d.dimension)).toEqual(requested);
  });

  it("非 JSON / 缺字段 / 缺维度：抛 ScoringError(SCORING_OUTPUT_INVALID)", () => {
    expect(() => parseScoringOutput("不是 JSON", requested)).toThrowError(ScoringError);
    expect(catchError(() => parseScoringOutput("不是 JSON", requested))).toMatchObject({
      code: CODES.SCORING_OUTPUT_INVALID,
    });

    const missingTopIssue = JSON.stringify({
      dimensions: [
        { dimension: "用户理解", raw_score: 82, diagnosis: "诊断一" },
        { dimension: "产品取舍", raw_score: 68, diagnosis: "诊断二" },
      ],
      next_focus: "下一步",
    });
    expect(catchError(() => parseScoringOutput(missingTopIssue, requested))).toMatchObject({
      code: CODES.SCORING_OUTPUT_INVALID,
    });

    const missingDimension = JSON.stringify({
      dimensions: [{ dimension: "用户理解", raw_score: 82, diagnosis: "诊断一" }],
      top_issue: "具体问题",
      next_focus: "下一步",
    });
    expect(catchError(() => parseScoringOutput(missingDimension, requested))).toMatchObject({
      code: CODES.SCORING_OUTPUT_INVALID,
    });
  });

  it("分数越界（<0 或 >100）或不是数字：抛 ScoringError", () => {
    const build = (score: unknown) =>
      JSON.stringify({
        dimensions: [
          { dimension: "用户理解", raw_score: score, diagnosis: "诊断一" },
          { dimension: "产品取舍", raw_score: 68, diagnosis: "诊断二" },
        ],
        top_issue: "具体问题",
        next_focus: "下一步",
      });
    for (const bad of [120, -1, "80", null]) {
      expect(catchError(() => parseScoringOutput(build(bad), requested))).toMatchObject({
        code: CODES.SCORING_OUTPUT_INVALID,
      });
    }
  });

  it("dimensions 元素结构非法或缺 next_focus：抛 ScoringError", () => {
    const build = (dimensions: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ dimensions, top_issue: "具体问题", next_focus: "下一步", ...extra });
    const cases = [
      build([null]), // 元素不是对象
      build(["用户理解"]), // 元素不是对象
      build([{ raw_score: 80, diagnosis: "诊断" }]), // 缺 dimension 字段
      build(
        [
          { dimension: "用户理解", raw_score: 80, diagnosis: "诊断一" },
          { dimension: "产品取舍", raw_score: 68, diagnosis: "诊断二" },
        ],
        { next_focus: "" }, // next_focus 为空
      ),
    ];
    for (const content of cases) {
      expect(catchError(() => parseScoringOutput(content, requested))).toMatchObject({
        code: CODES.SCORING_OUTPUT_INVALID,
      });
    }
  });

  it("诊断或最需优化问题为空串：抛 ScoringError（BR-7 兜底）", () => {
    const emptyDiagnosis = JSON.stringify({
      dimensions: [
        { dimension: "用户理解", raw_score: 82, diagnosis: "  " },
        { dimension: "产品取舍", raw_score: 68, diagnosis: "诊断二" },
      ],
      top_issue: "具体问题",
      next_focus: "下一步",
    });
    expect(catchError(() => parseScoringOutput(emptyDiagnosis, requested))).toMatchObject({
      code: CODES.SCORING_OUTPUT_INVALID,
    });

    const emptyTopIssue = JSON.stringify({
      dimensions: [
        { dimension: "用户理解", raw_score: 82, diagnosis: "诊断一" },
        { dimension: "产品取舍", raw_score: 68, diagnosis: "诊断二" },
      ],
      top_issue: "",
      next_focus: "下一步",
    });
    expect(catchError(() => parseScoringOutput(emptyTopIssue, requested))).toMatchObject({
      code: CODES.SCORING_OUTPUT_INVALID,
    });
  });
});

describe("scoreWithRubric：AI 网关调用参数", () => {
  it("低 temperature + json_object + 结构化输出预算 ≥2048（R1）", async () => {
    const client = fakeClient(validOutput);
    const output = await scoreWithRubric(input, { client });
    expect(output.dimensions).toHaveLength(2);

    expect(client.chatCompletion).toHaveBeenCalledTimes(1);
    const params = (client.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      temperature: number;
      maxCompletionTokens: number;
      responseFormat: { type: string };
    };
    expect(params.temperature).toBeLessThanOrEqual(0.3);
    expect(params.responseFormat).toEqual({ type: "json_object" });
    expect(params.maxCompletionTokens).toBeGreaterThanOrEqual(2048);
  });

  it("模型输出无法解析：抛 ScoringError（服务层据此安全重试）", async () => {
    await expect(scoreWithRubric(input, { client: fakeClient("乱码输出") })).rejects.toMatchObject(
      { code: CODES.SCORING_OUTPUT_INVALID },
    );
  });
});
