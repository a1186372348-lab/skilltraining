import { beforeEach, describe, expect, it, vi } from "vitest";
import { BaselineRequiredError } from "@/server/modules/baseline/result-visibility";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ user: vi.fn(), view: vi.fn() }));
vi.mock("@/server/lib/request-user", () => ({ getRequestUser: mocks.user }));
vi.mock("@/server/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/server/modules/dashboard/service", () => ({ getDashboardView: mocks.view }));

beforeEach(() => { vi.resetAllMocks(); mocks.user.mockResolvedValue({ id: "u" }); });

describe("首页出口错误边界", () => {
  it("未登录拒绝，基线未完成映射为安全 409", async () => {
    mocks.user.mockResolvedValueOnce(null);
    expect((await GET(new Request("http://localhost"))).status).toBe(401);
    mocks.view.mockRejectedValueOnce(new BaselineRequiredError());
    const response = await GET(new Request("http://localhost"));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("BASELINE_REQUIRED");
  });

  it("查询失败不放行；错误视图返回安全的 500", async () => {
    mocks.view.mockRejectedValueOnce(new Error("guard failed"));
    await expect(GET(new Request("http://localhost"))).rejects.toThrow("guard failed");
    mocks.view.mockResolvedValueOnce({ invalid: true });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await GET(new Request("http://localhost"));
      expect(response.status).toBe(500);
      expect((await response.json()).error.code).toBe("DASHBOARD_VIEW_INVALID");
    } finally { log.mockRestore(); }
  });
});
