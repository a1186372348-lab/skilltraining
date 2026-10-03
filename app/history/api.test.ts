import { afterEach, describe, expect, it, vi } from "vitest";

import type { HistoryDetailView, HistoryListView } from "./contract";
import { fetchHistoryDetail, fetchHistoryList } from "./api";

// 历史页 API 适配层测试（T10）：stub 全局 fetch，不出网。
// 覆盖：统一响应封装解析（成功取 data、失败抛服务端 message）、请求路径与分页参数。

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

describe("fetchHistoryList（GET /api/history）", () => {
  it("成功：解析 data 负载，路径携带分页参数", async () => {
    const payload: HistoryListView = {
      items: [],
      pagination: { page: 2, pageSize: 10, total: 25, totalPages: 3 },
    };
    const stub = stubFetch(200, { success: true, data: payload });

    const result = await fetchHistoryList(2);
    expect(result).toEqual(payload);
    expect(stub).toHaveBeenCalledWith(
      "/api/history?page=2&pageSize=10",
      expect.objectContaining({ headers: { "content-type": "application/json" } }),
    );
  });

  it("失败：抛出服务端 error.message", async () => {
    stubFetch(400, {
      success: false,
      error: { code: "INVALID_PAGINATION", message: "分页参数不合法" },
    });
    await expect(fetchHistoryList(0)).rejects.toThrow("分页参数不合法");
  });

  it("非 ok 且无 error 负载：抛兜底文案", async () => {
    stubFetch(500, {});
    await expect(fetchHistoryList(1)).rejects.toThrow("请求失败，请稍后重试");
  });
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
