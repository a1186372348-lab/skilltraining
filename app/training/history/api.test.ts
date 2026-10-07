import { afterEach, describe, expect, it, vi } from "vitest";

import type { HistoryDetailView } from "./contract";
import { fetchHistoryDetail } from "./api";

// 历史回放 API 适配层测试（T10；T25 起仅保留详情——列表调用已随旧列表页删除）：stub 全局 fetch，不出网。
// 覆盖：统一响应封装解析（成功取 data、失败抛服务端 message）、请求路径。

/** 构造一个返回固定 envelope 的 fetch stub */
function stubFetch(status: number, envelope: unknown) {
  const stub = vi.fn(async () =>
    new Response(JSON.stringify(envelope), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", stub);
  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchHistoryDetail（GET /api/history/:id）", () => {
  it("成功：解析回放视图", async () => {
    const payload = { sessionId: "s-1", missing: [] } as unknown as HistoryDetailView;
    const stub = stubFetch(200, { success: true, data: payload });
    const result = await fetchHistoryDetail("s-1");
    expect(result).toEqual(payload);
    expect(stub).toHaveBeenCalledWith("/api/history/s-1", expect.anything());
  });

  it("404：抛出服务端 message（详情页据此展示错误态）", async () => {
    stubFetch(404, {
      success: false,
      error: { code: "SESSION_NOT_FOUND", message: "训练记录不存在" },
    });
    await expect(fetchHistoryDetail("s-x")).rejects.toThrow("训练记录不存在");
  });
});
