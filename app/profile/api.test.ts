import { afterEach, expect, it, vi } from "vitest";
import { createTrainingPack, fetchAbilityProfile } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("画像接口保留基线错误码并为缺失错误详情提供安全提示", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: { code: "BASELINE_REQUIRED", message: "先完成基线" } }) }).mockResolvedValueOnce({ ok: false, json: async () => ({ success: false }) }));
  await expect(fetchAbilityProfile()).rejects.toMatchObject({ code: "BASELINE_REQUIRED", message: "先完成基线" });
  await expect(fetchAbilityProfile()).rejects.toMatchObject({ code: "UNKNOWN", message: "请求失败，请稍后重试" });
});

it("发起包返回 ID，失败及缺失 ID 均给安全提示", async () => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { pack: { id: "pack" } } }) })
    .mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: { code: "ACTIVE_PACK_EXISTS", message: "请先完成当前包" } }) })
    .mockResolvedValueOnce({ ok: false, json: async () => ({ success: false }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { pack: {} } }) }));
  expect(await createTrainingPack("问题定义")).toBe("pack");
  await expect(createTrainingPack("问题定义")).rejects.toMatchObject({ code: "ACTIVE_PACK_EXISTS", message: "请先完成当前包" });
  await expect(createTrainingPack("问题定义")).rejects.toMatchObject({ code: "UNKNOWN", message: "发起失败，请稍后重试" });
  await expect(createTrainingPack("问题定义")).rejects.toThrow("训练包信息暂不可用");
});
