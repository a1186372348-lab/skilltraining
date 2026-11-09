import { afterEach, expect, it, vi } from "vitest";
import { fetchStageOverview, startRetest } from "./api";

afterEach(() => vi.unstubAllGlobals());
it("阶段读取和指定触发开题遵守真实 JSON 请求契约", async () => {
  const responses = [{ stage: "exploration", baselineCompleted: true, dimensions: [], timeline: [] }, { state: "ready", triggerId: "trigger", sessionId: "session", awaitingScore: false }];
  const fetchMock = vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ success: true, data: responses.shift() }) }));
  vi.stubGlobal("fetch", fetchMock);
  expect(await fetchStageOverview()).toMatchObject({ stage: "exploration", baselineCompleted: true });
  expect(await startRetest("trigger")).toMatchObject({ state: "ready", sessionId: "session" });
  expect(fetchMock.mock.calls[0][0]).toBe("/api/stages/overview");
  expect(fetchMock.mock.calls[1][0]).toBe("/api/stages/retest/start");
  expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify({ triggerId: "trigger" }) });
});

it("基线和归属错误保留服务端错误码，错误响应缺字段时安全失败", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: { code: "BASELINE_REQUIRED", message: "先完成基线" } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
  vi.stubGlobal("fetch", fetchMock);
  await expect(fetchStageOverview()).rejects.toMatchObject({ code: "BASELINE_REQUIRED", message: "先完成基线" });
  await expect(startRetest("trigger")).rejects.toMatchObject({ code: "UNKNOWN", message: "阶段状态暂时无法读取，请稍后重试" });
});
