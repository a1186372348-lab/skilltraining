import { beforeEach, expect, it, vi } from "vitest";
import { BaselineRequiredError } from "@/server/modules/baseline/result-visibility";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ user: vi.fn(), view: vi.fn() }));
vi.mock("@/server/lib/request-user", () => ({ getRequestUser: mocks.user }));
vi.mock("@/server/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/server/modules/profile/ability-page", () => ({ getAbilityPageView: mocks.view }));
beforeEach(() => { vi.resetAllMocks(); mocks.user.mockResolvedValue({ id: "u" }); });

it("画像出口不吞掉查询异常，并安全返回基线门禁错误", async () => {
  mocks.user.mockResolvedValueOnce(null);
  expect((await GET(new Request("http://localhost"))).status).toBe(401);
  mocks.view.mockRejectedValueOnce(new BaselineRequiredError());
  expect((await GET(new Request("http://localhost"))).status).toBe(409);
  mocks.view.mockRejectedValueOnce(new Error("guard failed"));
  await expect(GET(new Request("http://localhost"))).rejects.toThrow("guard failed");
  mocks.view.mockResolvedValueOnce({ insight: "safe" });
  expect((await GET(new Request("http://localhost"))).status).toBe(200);
});
