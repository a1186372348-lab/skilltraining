import { afterEach, expect, it, vi } from "vitest";
import { fetchDashboard } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("首页接口保留基线错误码并为缺失错误详情提供安全提示", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: { code: "BASELINE_REQUIRED", message: "先完成基线" } }) }).mockResolvedValueOnce({ ok: false, json: async () => ({ success: false }) }));
  await expect(fetchDashboard()).rejects.toMatchObject({ code: "BASELINE_REQUIRED", message: "先完成基线" });
  await expect(fetchDashboard()).rejects.toMatchObject({ code: "UNKNOWN", message: "请求失败，请稍后重试" });
});
