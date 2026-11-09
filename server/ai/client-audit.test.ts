import { describe, expect, it, vi } from "vitest";
import { createAiClient, createAiClientFromEnv } from "./client";
import { buildRuntimeContract } from "./runtime-contract";
import { requestAudit, responseAudit } from "./client-audit";

const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const params = {
  messages: [{ role: "user" as const, content: "private-prompt-sentinel" }],
  temperature: 0.2,
  maxCompletionTokens: 4096,
  responseFormat: { type: "json_object" as const },
};
const payload = (content: string) => ({
  model: "deepseek-flash",
  system_fingerprint: "fp_test",
  choices: [{ finish_reason: "stop", message: { content } }],
  usage: { prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 1 } },
});
const AUDIT_MOCK_KEY = "mock-key";

function setup(fetchImpl: typeof fetch, maxRetries = 0) {
  const records: Record<string, unknown>[] = [];
  const client = createAiClient({ baseUrl: "https://example.test", apiKey: AUDIT_MOCK_KEY, fetchImpl, maxRetries, sleep: async () => {}, auditLog: (record) => records.push(record) });
  return { client, records };
}

describe("安全审计元数据", () => {
  it("请求保持逐字节不变，并记录请求事实与安全响应元数据", async () => {
    const fetchImpl = vi.fn(async () => response(payload("answer-sentinel"))) as unknown as typeof fetch;
    const { client, records } = setup(fetchImpl);
    const result = await client.chatCompletion(params);
    expect(result.content).toBe("answer-sentinel");
    expect((vi.mocked(fetchImpl).mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify({ model: "deepseek-flash", messages: params.messages, temperature: 0.2, max_tokens: 4096, thinking: { type: "enabled" }, reasoning_effort: "high", response_format: { type: "json_object" } }));
    expect(records[0]).toMatchObject({ requestTemperature: 0.2, requestTokenLimitField: "max_tokens", requestTokenLimit: 4096, requestThinking: "enabled", requestEffort: "high", responseServedModel: "deepseek-flash", responseFinishReason: "stop", responseReasoningTokens: 1 });
    expect(records[0].responseFingerprintHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(records)).not.toContain("sentinel");
    expect(JSON.stringify(records)).not.toContain(AUDIT_MOCK_KEY);
    expect(JSON.stringify(records)).not.toContain("fp_test");
  });
  it("空正文最终失败保留该次响应元数据", async () => {
    const { client, records } = setup(vi.fn(async () => response(payload(""))) as unknown as typeof fetch);
    await expect(client.chatCompletion(params)).rejects.toThrow();
    expect(records[0]).toMatchObject({ responseFinishReason: "stop", responseReasoningTokens: 1 });
  });
  it("重试成功仅记录最后响应", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(payload(""))).mockResolvedValueOnce(response({ ...payload("ok"), choices: [{ finish_reason: "length", message: { content: "ok" } }] }));
    const { client, records } = setup(fetchImpl as unknown as typeof fetch, 1);
    await client.chatCompletion(params);
    expect(records[0]).toMatchObject({ attempts: 2, responseFinishReason: "length" });
  });
  it("带副作用的参数读取只按原请求流程执行且审计匹配报文", async () => {
    let reads = 0;
    const input = { ...params, get temperature() { reads += 1; return reads / 10; } };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response(payload("ok")));
    const { client, records } = setup(fetchImpl as unknown as typeof fetch);
    await client.chatCompletion(input);
    const sent = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(reads).toBe(1);
    expect(records[0].requestTemperature).toBe(sent.temperature);
  });
  it("参数读取异常仍走既有重试路径且不伪造请求元数据", async () => {
    let reads = 0;
    const input = { ...params, get temperature(): number { reads += 1; throw new Error("private-sentinel"); } };
    const fetchImpl = vi.fn();
    const { client, records } = setup(fetchImpl as unknown as typeof fetch, 1);
    await expect(client.chatCompletion(input)).rejects.toThrow("AI API 网络错误");
    expect(reads).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({ attempts: 2, requestTemperature: null, requestTokenLimitField: "unknown", requestTokenLimit: null });
    expect(JSON.stringify(records)).not.toContain("private-sentinel");
  });
  it("重试时审计使用最后一次实际发送的请求参数", async () => {
    const mutable = { ...params, temperature: 0.2, maxCompletionTokens: 4096 };
    const records: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(response(payload("ok")));
    const client = createAiClient({ baseUrl: "https://example.test", apiKey: "fake", fetchImpl, maxRetries: 1, sleep: async () => { mutable.temperature = 0.4; mutable.maxCompletionTokens = 2048; }, auditLog: (record) => records.push(record) });
    await client.chatCompletion(mutable);
    const sent = JSON.parse(String(fetchImpl.mock.calls[1][1].body));
    expect(records[0]).toMatchObject({ requestTemperature: sent.temperature, requestTokenLimit: sent.max_tokens });
  });
  it("默认日志与默认退避保持可用", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(response(payload("ok")));
    const client = createAiClient({ baseUrl: "https://example.test", apiKey: "fake", fetchImpl, maxRetries: 1 });
    try {
      const pending = client.chatCompletion(params);
      await vi.runAllTimersAsync();
      await pending;
      expect(info).toHaveBeenCalledOnce();
    } finally {
      info.mockRestore();
      vi.useRealTimers();
    }
  });
  it("可通过既有环境入口构建客户端", () => {
    vi.stubEnv("DEEPSEEK_BASE_URL", "https://example.test");
    vi.stubEnv("DEEPSEEK_API_KEY", "fake");
    try {
      expect(createAiClientFromEnv().chatCompletion).toBeTypeOf("function");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("末次网络错误不沿用前次响应", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(payload(""))).mockRejectedValueOnce(new Error(AUDIT_MOCK_KEY));
    const { client, records } = setup(fetchImpl as unknown as typeof fetch, 1);
    await expect(client.chatCompletion(params)).rejects.toThrow();
    expect(records[0]).toMatchObject({ responseFinishReason: null, responseReasoningTokens: null, responseServedModel: null, responseFingerprintHash: null });
    expect(JSON.stringify(records)).not.toContain("sentinel");
    expect(JSON.stringify(records)).not.toContain(AUDIT_MOCK_KEY);
  });
  it("末次非200不沿用前次响应", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(payload(""))).mockResolvedValueOnce(new Response("private-response", { status: 400 }));
    const { client, records } = setup(fetchImpl as unknown as typeof fetch, 1);
    await expect(client.chatCompletion(params)).rejects.toThrow();
    expect(records[0]).toMatchObject({ responseFinishReason: null, responseServedModel: null });
    expect(JSON.stringify(records)).not.toContain("private-response");
  });
  it("无默认上限和无响应信息均清晰标记", () => {
    expect(requestAudit(buildRuntimeContract("deepseek-flash", 0.3))).toMatchObject({ requestTemperature: 0.3, requestTokenLimitField: "max_tokens", requestTokenLimit: 24576 });
    expect(responseAudit(null)).toEqual({ responseServedModel: null, responseFinishReason: null, responseReasoningTokens: null, responseFingerprintHash: null });
  });
  it.each([-1, Number.MAX_SAFE_INTEGER + 1, "9", null])("拒绝无效计数 %s", (value) => {
    const output = responseAudit({ usage: { completion_tokens_details: { reasoning_tokens: value } } });
    expect(output.responseReasoningTokens).toBeNull();
  });
  it.each(["a".repeat(129), "private prompt !", 8])("拒绝非法指纹 %s", (value) => {
    const output = responseAudit({ system_fingerprint: value });
    expect(output.responseFingerprintHash).toBeNull();
  });
  it("拒绝未知模型、结束原因及错误嵌套类型", () => {
    const output = responseAudit({ model: AUDIT_MOCK_KEY, choices: [{ finish_reason: "unknown" }], usage: [] });
    expect(output).toEqual({ responseServedModel: null, responseFinishReason: null, responseReasoningTokens: null, responseFingerprintHash: null });
  });
});
