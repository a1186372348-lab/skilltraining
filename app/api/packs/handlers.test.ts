import { describe, expect, it, vi } from "vitest";

import { PACK_ERROR_CODES, PackError } from "@/server/modules/packs";
import { UserTransactionError } from "@/server/lib/user-transaction";
import { createPackHandlers, type PackRouteDependencies } from "./handlers";

const id = "cbd954ea-52f7-492a-bc20-d7084cc6b961";
const user = "6729c899-63d9-4a0c-95c6-1d0d842fc8c8";
const pack = { id, dimension: "问题定义", status: "active", createdAt: new Date("2026-11-03T00:00:00Z"), endedAt: null, items: [], diagnosis: {} };
const context = (itemId = id, index = "0") => ({ params: Promise.resolve({ id: itemId, index }) });
const request = (body?: unknown) => new Request("http://localhost/api/packs", {
  method: "POST", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});

function dependencies(): PackRouteDependencies {
  return {
    getUser: vi.fn(async () => ({ id: user })),
    getActive: vi.fn(async () => pack as never),
    create: vi.fn(async () => pack as never),
    get: vi.fn(async () => pack as never),
    abandon: vi.fn(async () => pack as never),
    start: vi.fn(async () => ({ sessionId: id, state: "in_progress" as const })),
  };
}

describe("训练包接口", () => {
  it("未登录时不读取或写入训练包", async () => {
    const deps = dependencies();
    deps.getUser = vi.fn(async () => null);
    const handlers = createPackHandlers(deps);
    expect((await handlers.active(new Request("http://localhost"))).status).toBe(401);
    expect((await handlers.create(request({ dimension: "问题定义" }))).status).toBe(401);
    expect((await handlers.detail(request(), context())).status).toBe(401);
    expect((await handlers.abandon(request({ confirmed: true }), context())).status).toBe(401);
    expect((await handlers.start(request(), context())).status).toBe(401);
    expect(deps.getActive).not.toHaveBeenCalled();
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("创建输入校验并输出 ISO 时间，不向接口泄露实现字段", async () => {
    const deps = dependencies();
    const handlers = createPackHandlers(deps);
    expect((await handlers.create(request({ dimension: "不存在" }))).status).toBe(400);
    expect(deps.create).not.toHaveBeenCalled();
    const response = await handlers.create(request({ dimension: "问题定义" }));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.pack.createdAt).toBe("2026-11-03T00:00:00.000Z");
    expect(JSON.stringify(json)).not.toMatch(/rubric|standardReference/);
    expect(deps.create).toHaveBeenCalledWith(user, "问题定义");
  });

  it("不存在或不属于本人返回同一 404，基线未完成返回 409", async () => {
    const deps = dependencies();
    deps.get = vi.fn(async () => { throw new PackError(PACK_ERROR_CODES.PACK_NOT_FOUND, 404, "训练包不存在"); });
    deps.create = vi.fn(async () => { throw new PackError(PACK_ERROR_CODES.BASELINE_REQUIRED, 409, "请先完成基线测评"); });
    const handlers = createPackHandlers(deps);
    expect((await handlers.detail(new Request("http://localhost"), context())).status).toBe(404);
    const response = await handlers.create(request({ dimension: "问题定义" }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("BASELINE_REQUIRED");
  });

  it("放弃必须显式确认，未确认不能调用业务写入", async () => {
    const deps = dependencies();
    const handlers = createPackHandlers(deps);
    const refused = await handlers.abandon(request({ confirmed: false }), context());
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("CONFIRMATION_REQUIRED");
    expect(deps.abandon).not.toHaveBeenCalled();
    expect((await handlers.abandon(request({ confirmed: true }), context())).status).toBe(200);
    expect(deps.abandon).toHaveBeenCalledWith(user, id, { confirmed: true });
  });

  it("只接受 0–4 的题序并保留锁定错误", async () => {
    const deps = dependencies();
    deps.start = vi.fn(async () => { throw new PackError(PACK_ERROR_CODES.ITEM_LOCKED, 409, "训练题尚未解锁"); });
    const handlers = createPackHandlers(deps);
    expect((await handlers.start(request(), context(id, "5"))).status).toBe(400);
    expect(deps.start).not.toHaveBeenCalled();
    const response = await handlers.start(request(), context(id, "2"));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("ITEM_LOCKED");
  });

  it("拒绝非法 JSON、额外字段和无效包编号，均不产生写入", async () => {
    const deps = dependencies();
    const handlers = createPackHandlers(deps);
    const malformed = () => new Request("http://localhost", { method: "POST", body: "{" });
    expect((await handlers.create(malformed())).status).toBe(400);
    expect((await handlers.abandon(malformed(), context())).status).toBe(400);
    expect((await handlers.abandon(request({ confirmed: true, extra: true }), context())).status).toBe(400);
    expect((await handlers.detail(request(), context("invalid"))).status).toBe(400);
    expect((await handlers.abandon(request({ confirmed: true }), context("invalid"))).status).toBe(400);
    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.abandon).not.toHaveBeenCalled();
  });

  it("用户在事务前消失时返回未登录，未知异常继续交由统一错误处理", async () => {
    const deps = dependencies();
    deps.getActive = vi.fn(async () => { throw new UserTransactionError(); });
    const handlers = createPackHandlers(deps);
    expect((await handlers.active(request())).status).toBe(401);
    deps.getActive = vi.fn(async () => { throw new Error("unavailable"); });
    await expect(handlers.active(request())).rejects.toThrow("unavailable");
  });
});
