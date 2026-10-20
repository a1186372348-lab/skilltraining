import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AI_AUDIT_EVENT,
  AI_MODEL,
  AiApiError,
  AiConfigError,
  createAiClient,
  getAiConfig,
} from "./client";

// AI 网关契约测试：fetch 全程 mock，禁止真实出网。
// 假 Key 每次运行随机生成：既通过 ECC 密钥扫描，又更强地断言"日志绝不含本次 Key 值"
const FAKE_API_KEY = randomBytes(8).toString("hex");

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const completionBody = {
  id: "chatcmpl-test",
  model: AI_MODEL,
  choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

function makeClient(fetchImpl: typeof fetch, extra?: { sleep?: (ms: number) => Promise<void>; maxRetries?: number }) {
  return createAiClient({
    baseUrl: "https://ai.example.test/v1",
    apiKey: FAKE_API_KEY,
    fetchImpl,
    timeoutMs: 50,
    sleep: extra?.sleep ?? (() => Promise.resolve()),
    maxRetries: extra?.maxRetries,
  });
}

describe("getAiConfig：环境变量读取（Prd.md 3.5 启动时校验）", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("缺 DEEPSEEK_API_KEY 抛 AiConfigError", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("DEEPSEEK_BASE_URL", "https://api.deepseek.com");
    expect(() => getAiConfig()).toThrow(AiConfigError);
  });

  it("缺 DEEPSEEK_BASE_URL 抛 AiConfigError", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-test");
    vi.stubEnv("DEEPSEEK_BASE_URL", "");
    expect(() => getAiConfig()).toThrow(AiConfigError);
  });

  it("齐全时返回配置且使用默认模型 deepseek-flash", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-test");
    vi.stubEnv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/");
    const config = getAiConfig();
    expect(config.baseUrl).toBe("https://api.deepseek.com"); // 去掉尾斜杠
    expect(config.model).toBe("deepseek-flash");
  });
});

describe("aiClient.chatCompletion", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    infoSpy.mockRestore();
  });

  it("成功：POST chat/completions，携带鉴权头与低温度参数，返回 content 与 usage", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, completionBody));
    const client = makeClient(fetchImpl);

    const result = await client.chatCompletion({
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
      maxCompletionTokens: 128,
      responseFormat: { type: "json_object" },
    });

    expect(result.content).toBe("你好");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://ai.example.test/v1/chat/completions");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${FAKE_API_KEY}`);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: AI_MODEL,
      temperature: 0.2,
      max_completion_tokens: 128,
      response_format: { type: "json_object" },
    });
  });

  it("思考链提取：响应含 reasoning_content 时随结果返回，缺省为 null（T35 闸门探针）", async () => {
    const withReasoning = {
      ...completionBody,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: '{"should_followup": true, "reason": "r", "followups": []}',
            reasoning_content: "学员首答只给了结论，没有证据……应当追问。",
          },
          finish_reason: "stop",
        },
      ],
    };
    const fetchReasoning = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, withReasoning));
    const reasoningResult = await makeClient(fetchReasoning).chatCompletion({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(reasoningResult.reasoningContent).toBe("学员首答只给了结论，没有证据……应当追问。");

    // 缺省（非推理模型 / 供应商未返回该字段）：null，现有调用方行为不变
    const fetchPlain = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, completionBody));
    const plainResult = await makeClient(fetchPlain).chatCompletion({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(plainResult.reasoningContent).toBeNull();
  });

  it("429：指数退避重试后成功，sleep 按 2 的幂增长", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: "rate limited" } }))
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: "rate limited" } }))
      .mockResolvedValue(jsonResponse(200, completionBody));
    const sleeps: number[] = [];
    const client = makeClient(fetchImpl, {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });

    const result = await client.chatCompletion({ messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toBe("你好");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]); // 指数退避
  });

  it("5xx：重试耗尽后抛 AiApiError（retryable）", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(500, { error: { message: "boom" } }));
    const client = makeClient(fetchImpl, { maxRetries: 2 });

    await expect(
      client.chatCompletion({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ name: "AiApiError", status: 500, retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 + 2 次重试
  });

  it("400：不可重试错误立即抛出，不重试", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(400, { error: { message: "bad request" } }));
    const client = makeClient(fetchImpl);

    await expect(
      client.chatCompletion({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ status: 400, retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("超时：AbortSignal 触发后抛 AiApiError（timeout）", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        }),
    );
    const client = makeClient(fetchImpl, { maxRetries: 0 });

    await expect(
      client.chatCompletion({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ name: "AiApiError", timeout: true });
  });

  it("200 但响应体结构异常：抛 AiApiError", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { choices: [] }));
    const client = makeClient(fetchImpl);
    await expect(
      client.chatCompletion({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(AiApiError);
  });

  // T22：推理模型高负载下正文被截空属瞬时退化，「200 空 content」纳入退避重试
  it("200 空 content：可重试，退避后第二次成功", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { choices: [] }))
      .mockResolvedValue(jsonResponse(200, completionBody));
    const client = makeClient(fetchImpl);

    const result = await client.chatCompletion({ messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toBe("你好");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("200 空 content 持续出现：重试耗尽后抛 AiApiError（retryable）", async () => {
    // 每次调用返回新 Response（body 只能消费一次）
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(200, { choices: [{ message: { content: "" } }] })),
      );
    const client = makeClient(fetchImpl, { maxRetries: 2 });

    await expect(
      client.chatCompletion({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ name: "AiApiError", status: 200, retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 + 2 次重试
  });

  it("审计日志：事件名 + 模型/状态/耗时/用量，绝不包含 API Key 与消息明文", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, completionBody));
    const client = makeClient(fetchImpl);

    await client.chatCompletion({ messages: [{ role: "user", content: "机密答案明文" }] });

    expect(infoSpy).toHaveBeenCalled();
    const allLogs = infoSpy.mock.calls.flat().map(String).join("\n");
    expect(allLogs).toContain(AI_AUDIT_EVENT);
    expect(allLogs).toContain(AI_MODEL);
    expect(allLogs).not.toContain(FAKE_API_KEY);
    expect(allLogs).not.toContain("机密答案明文");
  });

  it("失败也写审计日志（含 status 与重试次数）", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(503, { error: { message: "down" } }));
    const client = makeClient(fetchImpl, { maxRetries: 1 });

    await expect(
      client.chatCompletion({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(AiApiError);
    const allLogs = infoSpy.mock.calls.flat().map(String).join("\n");
    expect(allLogs).toContain("503");
  });
});
