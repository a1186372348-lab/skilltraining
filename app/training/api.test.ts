import { afterEach, describe, expect, it, vi } from "vitest";

import type { TrainingHubView } from "./contract";
import { fetchTrainingHub } from "./api";

// 产品训练大厅 API 适配层测试（T25 / D27）：stub 全局 fetch，不出网。
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

describe("fetchTrainingHub（GET /api/training/hub）", () => {
  it("成功：解析 data 负载，请求路径正确", async () => {
    const payload: TrainingHubView = {
      current: { kind: "not_started", dateKey: "2026-10-07" },
      history: [],
      streakDays: 0,
    };
    const stub = stubFetch(200, { success: true, data: payload });

    const result = await fetchTrainingHub();
    expect(result).toEqual(payload);
    expect(stub).toHaveBeenCalledWith("/api/training/hub", expect.anything());
  });

  it("失败：抛出服务端 error.message", async () => {
    stubFetch(401, {
      success: false,
      error: { code: "UNAUTHORIZED", message: "未登录或登录已过期" },
    });
    await expect(fetchTrainingHub()).rejects.toThrow("未登录或登录已过期");
  });

  it("非 ok 且无 error 负载：抛兜底文案", async () => {
    stubFetch(500, {});
    await expect(fetchTrainingHub()).rejects.toThrow("请求失败，请稍后重试");
  });
});
