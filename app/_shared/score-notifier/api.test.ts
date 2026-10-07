import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchScoreNotifications } from "./api";

// 全局通知 API 适配层测试（T24）：stub 全局 fetch，不出网。
// 覆盖：统一响应封装解析、脏数据防御过滤、失败静默语义——
// 401 / 网络错误 / 非 success 一律返回空 items（通知绝不影响页面渲染）。

function stubFetch(status: number, envelope: unknown) {
  const stub = vi.fn(
    async () =>
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

describe("fetchScoreNotifications（GET /api/training/score-notifications）", () => {
  it("成功：解析 items 负载", async () => {
    const items = [
      { sessionId: "s-1", caseTitle: "案例一", kind: "scored", occurredAt: "2026-10-07T11:00:00.000Z" },
      { sessionId: "s-2", caseTitle: "案例二", kind: "stuck", occurredAt: "2026-10-07T10:50:00.000Z" },
    ];
    const stub = stubFetch(200, { success: true, data: { items } });

    const result = await fetchScoreNotifications();
    expect(result).toEqual(items);
    expect(stub).toHaveBeenCalledWith(
      "/api/training/score-notifications",
      expect.objectContaining({ headers: { "content-type": "application/json" } }),
    );
  });

  it("脏数据：形状非法的项被过滤，不抛错", async () => {
    stubFetch(200, {
      success: true,
      data: {
        items: [
          { sessionId: "s-1", caseTitle: "案例一", kind: "scored", occurredAt: "2026-10-07T11:00:00.000Z" },
          { sessionId: 123 },
          { sessionId: "s-2", caseTitle: "案例二", kind: "unknown", occurredAt: "x" },
          null,
        ],
      },
    });
    const result = await fetchScoreNotifications();
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("s-1");
  });

  it("401 未登录：静默返回空 items（登录页轮询不报错）", async () => {
    stubFetch(401, { success: false, error: { code: "UNAUTHORIZED", message: "未登录" } });
    expect(await fetchScoreNotifications()).toEqual([]);
  });

  it("网络错误 / 非 success / data 缺失：一律静默返回空 items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await fetchScoreNotifications()).toEqual([]);

    stubFetch(500, { success: false });
    expect(await fetchScoreNotifications()).toEqual([]);

    stubFetch(200, { success: true });
    expect(await fetchScoreNotifications()).toEqual([]);
  });
});
