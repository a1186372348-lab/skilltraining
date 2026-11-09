import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ abandon: vi.fn(), getUser: vi.fn() }));
vi.mock("@/server/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/server/lib/request-user", () => ({ getRequestUser: mocks.getUser }));
vi.mock("@/server/modules/training/service", () => ({ abandonSession: mocks.abandon }));
vi.mock("@/server/modules/training/rate-limit", () => ({ aiEndpointRateLimiter: { check: () => ({ allowed: true }) } }));

import { POST } from "./route";

const id = "cbd954ea-52f7-492a-bc20-d7084cc6b961";
const context = { params: Promise.resolve({ id }) };

beforeEach(() => { mocks.abandon.mockReset(); mocks.getUser.mockResolvedValue({ id: "user-1" }); });

it("包题确认字段必须显式传给训练服务", async () => {
  mocks.abandon.mockResolvedValue({ state: "abandoned" });
  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ confirmAbandonPack: true }) }), context);
  expect(response.status).toBe(200);
  expect(mocks.abandon).toHaveBeenCalledWith(expect.anything(), id, "user-1", { confirmAbandonPack: true });
});

it("普通终止兼容空请求体，非法 JSON 不能触发写入", async () => {
  mocks.abandon.mockResolvedValue({ state: "abandoned" });
  expect((await POST(new Request("http://localhost", { method: "POST" }), context)).status).toBe(200);
  expect(mocks.abandon).toHaveBeenCalledWith(expect.anything(), id, "user-1", { confirmAbandonPack: false });
  mocks.abandon.mockClear();
  expect((await POST(new Request("http://localhost", { method: "POST", body: "{" }), context)).status).toBe(400);
  expect(mocks.abandon).not.toHaveBeenCalled();
});
