import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(), getActive: vi.fn(), create: vi.fn(), get: vi.fn(), abandon: vi.fn(), start: vi.fn(),
}));
vi.mock("@/server/lib/request-user", () => ({ getRequestUser: mocks.getUser }));
vi.mock("@/server/lib/prisma", () => ({ prisma: { tag: "db" } }));
vi.mock("@/server/modules/packs", async original => ({
  ...(await original<typeof import("@/server/modules/packs")>()),
  getActivePack: mocks.getActive, createPack: mocks.create, getPack: mocks.get,
  abandonPack: mocks.abandon, openPackItem: mocks.start,
}));

import { createPackHandlers } from "./handlers";

const id = "cbd954ea-52f7-492a-bc20-d7084cc6b961";
const context = { params: Promise.resolve({ id, index: "3" }) };
const request = (body: object = {}) => new Request("http://localhost", { method: "POST", body: JSON.stringify(body) });

describe("训练包路由默认依赖", () => {
  it("以登录用户和服务器数据库调用每个包域入口", async () => {
    mocks.getUser.mockResolvedValue({ id: "owner" });
    mocks.getActive.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ id });
    mocks.get.mockResolvedValue({ id });
    mocks.abandon.mockResolvedValue({ id });
    mocks.start.mockResolvedValue({ sessionId: "s", state: "in_progress" });
    const handlers = createPackHandlers();
    expect((await handlers.active(request())).status).toBe(200);
    expect((await handlers.create(request({ dimension: "问题定义" }))).status).toBe(200);
    expect((await handlers.detail(request(), context)).status).toBe(200);
    expect((await handlers.abandon(request({ confirmed: true }), context)).status).toBe(200);
    expect((await handlers.start(request(), context)).status).toBe(200);
    const db = { tag: "db" };
    expect(mocks.getUser).toHaveBeenCalledWith(db, expect.any(Request));
    expect(mocks.getActive).toHaveBeenCalledWith(db, "owner");
    expect(mocks.create).toHaveBeenCalledWith(db, "owner", "问题定义");
    expect(mocks.get).toHaveBeenCalledWith(db, "owner", id);
    expect(mocks.abandon).toHaveBeenCalledWith(db, "owner", id, { confirmed: true });
    expect(mocks.start).toHaveBeenCalledWith(db, "owner", id, 3);
  });
});
