import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiClient } from "./client";

afterEach(() => { vi.useRealTimers(); });

describe("AI request deadline", () => {
  it("stops a later attempt at the absolute deadline without sending it to the provider", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) return Promise.resolve(new Response("", { status: 503 }));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const client = createAiClient({ baseUrl: "https://example.test", apiKey: "test", fetchImpl: fetchMock as typeof fetch, auditLog: vi.fn() });
    const result = client.chatCompletion({ messages: [{ role: "user", content: "test" }], deadlineMs: 2_000 });
    const checked = expect(result).rejects.toMatchObject({ retryable: true, timeout: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await checked;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).not.toHaveProperty("deadlineMs");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start an attempt when the deadline has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const fetchMock = vi.fn();
    const client = createAiClient({ baseUrl: "https://example.test", apiKey: "test", fetchImpl: fetchMock, auditLog: vi.fn() });
    await expect(client.chatCompletion({ messages: [], deadlineMs: 100 })).rejects.toMatchObject({ retryable: true, timeout: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds response body reading and clears the timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    } as Response));
    const client = createAiClient({ baseUrl: "https://example.test", apiKey: "test", fetchImpl: fetchMock as typeof fetch, auditLog: vi.fn() });
    const checked = expect(client.chatCompletion({ messages: [], deadlineMs: 1_000 })).rejects.toMatchObject({ timeout: true, retryable: true });
    await vi.advanceTimersByTimeAsync(1_000);
    await checked;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clips retry backoff to the remaining time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi.fn(async () => new Response("", { status: 503 }));
    const client = createAiClient({ baseUrl: "https://example.test", apiKey: "test", fetchImpl: fetchMock as typeof fetch, auditLog: vi.fn() });
    const checked = expect(client.chatCompletion({ messages: [], deadlineMs: 200 })).rejects.toMatchObject({ timeout: true, retryable: true });
    await vi.advanceTimersByTimeAsync(200);
    await checked;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
