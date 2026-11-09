import { describe, expect, it, vi } from "vitest";
import { createAiClient } from "./client";
import { buildRuntimeContract } from "./runtime-contract";
import { promptEvidence } from "../../scripts/lib/regression-evidence";

describe("运行契约", () => {
  it("默认预算与模式固定并携带稳定摘要", () => {
    const result = buildRuntimeContract("deepseek-flash", 0.2);
    expect(result).toMatchObject({ model: "deepseek-flash", thinking: "enabled", effort: "high", maxTokens: 24576, maxTokensField: "max_tokens", temperature: 0.2, temperatureApplicability: "ineffective_in_thinking" });
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(buildRuntimeContract("deepseek-flash", 0.2).hash).toBe(result.hash);
    expect(buildRuntimeContract("deepseek-flash", 0.2, 2048).hash).not.toBe(result.hash);
  });
  it("发送报文与回归证据共享同一配置及摘要", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    const audit: Record<string, unknown>[] = [];
    const client = createAiClient({ baseUrl: "https://example.test", apiKey: "fake", fetchImpl, auditLog: (record) => audit.push(record) });
    await client.chatCompletion({ messages: [], temperature: 0.2 });
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    const evidence = promptEvidence("database", "v1", "content", 0.2).runtimeContract;
    expect(body).toMatchObject({ model: evidence.model, temperature: evidence.temperature, max_tokens: evidence.maxTokens, thinking: { type: evidence.thinking }, reasoning_effort: evidence.effort });
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(audit[0]).toMatchObject({ requestModel: evidence.model, requestTemperature: evidence.temperature, requestTemperatureApplicability: evidence.temperatureApplicability, requestTokenLimitField: evidence.maxTokensField, requestTokenLimit: evidence.maxTokens, requestThinking: evidence.thinking, requestEffort: evidence.effort, requestContractHash: evidence.hash });
  });
  it.each([0, -1, 24577, 1.5, NaN, Infinity, null, "24576"])("非法预算 %s 在调用前拒绝且不泄露值", async (budget) => {
    const fetchImpl = vi.fn();
    const client = createAiClient({baseUrl:"https://example.test",apiKey:"fake",fetchImpl:fetchImpl as unknown as typeof fetch});
    await expect(client.chatCompletion({messages:[],maxCompletionTokens:budget as number})).rejects.toThrow("无效的 AI 运行配置");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
