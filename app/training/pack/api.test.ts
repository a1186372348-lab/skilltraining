import { afterEach, expect, it, vi } from "vitest";
import { abandonPack, abandonPackSession, createPack, fetchActivePack, fetchPack, PackApiError, startPackItem } from "./api";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("包接口保持 JSON 线上的 ISO 日期，并明确序号与确认字段", async () => {
  const pack = { id: "pack-1", createdAt: "2026-11-03T00:00:00.000Z", endedAt: null };
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { pack, sessionId: "session", state: "reading" } }) });
  vi.stubGlobal("fetch", fetcher);
  expect((await fetchActivePack())?.createdAt).toBe("2026-11-03T00:00:00.000Z");
  expect((await fetchPack("pack-1")).endedAt).toBeNull();
  await createPack("问题定义");
  await startPackItem("pack-1", 2);
  await abandonPack("pack-1");
  await abandonPackSession("session");
  expect(fetcher).toHaveBeenCalledWith("/api/packs", expect.objectContaining({ method: "POST", body: JSON.stringify({ dimension: "问题定义" }) }));
  expect(fetcher).toHaveBeenCalledWith("/api/packs/pack-1/items/2/start", expect.objectContaining({ method: "POST" }));
  expect(fetcher).toHaveBeenCalledWith("/api/packs/pack-1/abandon", expect.objectContaining({ method: "POST", body: JSON.stringify({ confirmed: true }) }));
  expect(fetcher).toHaveBeenCalledWith("/api/training/session/abandon", expect.objectContaining({ method: "POST", body: JSON.stringify({ confirmAbandonPack: true }) }));
});

it("无活动包返回 null；服务端失败带安全错误码", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { pack: null } }) })
    .mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: { code: "ITEM_LOCKED", message: "请先完成上一题" } }) }));
  expect(await fetchActivePack()).toBeNull();
  await expect(startPackItem("pack", 1)).rejects.toMatchObject({ code: "ITEM_LOCKED", message: "请先完成上一题" });
  expect(new PackApiError("X", "错误").code).toBe("X");
});

it("缺失响应数据或错误详情时按安全默认错误处理", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }));
  await expect(fetchPack("missing")).rejects.toMatchObject({ code: "UNKNOWN", message: "请求失败，请稍后重试" });
});
