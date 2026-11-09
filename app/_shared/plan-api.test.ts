import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCurrentPlan, fetchPlanReview, pendingHintOf, PlanApiError, postPlanAction } from "./plan-api";

afterEach(() => vi.unstubAllGlobals());

describe("计划的基线引导", () => {
  it("未完成基线与画像待补测使用同一引导，其他错误不冒充基线状态", () => {
    const incomplete = pendingHintOf(new PlanApiError("PROFILE_INCOMPLETE", ""));
    expect(incomplete).toContain("基线");
    expect(pendingHintOf(new PlanApiError("BASELINE_REQUIRED", ""))).toBe(incomplete);
    expect(pendingHintOf(new PlanApiError("OTHER", ""))).toBeNull();
    expect(pendingHintOf(null)).toBeNull();
  });
});

it("计划读取和操作保留接口错误码，并正确调用各自入口", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: { code: "BASELINE_REQUIRED", message: "先完成基线" } }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { review: null } }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { review: null } }) }).mockResolvedValueOnce({ ok: false, json: async () => ({ success: false }) });
  vi.stubGlobal("fetch", fetchMock);
  await expect(fetchCurrentPlan()).rejects.toMatchObject({ code: "BASELINE_REQUIRED" });
  await expect(fetchPlanReview()).resolves.toEqual({ review: null });
  await postPlanAction("reject");
  expect(fetchMock.mock.calls[2][0]).toBe("/api/plans/reject");
  expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ action: "reject" });
  await expect(fetchCurrentPlan()).rejects.toMatchObject({ code: "UNKNOWN", message: "请求失败，请稍后重试" });
});
