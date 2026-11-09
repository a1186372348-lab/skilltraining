// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HangingPlanCard, PlanSection } from "./plan-cards";

const mocks = vi.hoisted(() => ({ current: vi.fn(), review: vi.fn(), action: vi.fn(), hint: vi.fn() }));
vi.mock("./plan-api", () => ({ fetchCurrentPlan: mocks.current, fetchPlanReview: mocks.review, postPlanAction: mocks.action, pendingHintOf: mocks.hint }));
const plan = { id: "p", weekStartDate: "2026-10-26", focusDimension: "问题定义", startScore: 50, targetScore: 60, status: "active" as const, reason: "针对当前薄弱项", createdAt: "2026-10-26" };
const progress = { scoredCount: 1, completedDays: 1, completedDates: ["2026-10-26"] };
const load = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-28T12:00:00Z")); vi.clearAllMocks(); mocks.review.mockResolvedValue({ review: null }); mocks.hint.mockReturnValue(null); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("周计划组件", () => {
  it("按真实完成日期呈现，并在拒绝与撤销后刷新", async () => {
    mocks.current.mockResolvedValueOnce({ plan, progress }).mockResolvedValueOnce({ plan: { ...plan, status: "rejected" }, progress }).mockResolvedValue({ plan, progress });
    mocks.action.mockResolvedValue({});
    await act(async () => { render(<PlanSection />); }); await load();
    const monday = screen.getByText("10/26").parentElement!;
    const tuesday = screen.getByText("10/27").parentElement!;
    expect(monday.className).toContain("bg-[#EFF5FF]");
    expect(tuesday.className).not.toContain("bg-[#EFF5FF]");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "拒绝本周计划" })); });
    expect(mocks.action).toHaveBeenCalledWith("reject");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "撤销拒绝" })); });
    expect(mocks.action).toHaveBeenCalledWith("unreject");
    expect(screen.getByRole("button", { name: "拒绝本周计划" })).toBeTruthy();
  });
  it("显示回顾和首页计划入口；回顾失败不影响主卡", async () => {
    mocks.current.mockResolvedValue({ plan, progress });
    mocks.review.mockResolvedValueOnce({ review: { plan, scoredCount: 1, completedDays: 1, startScore: 50, latestScore: 55, scoreChange: 5 } });
    await act(async () => { render(<><PlanSection /><HangingPlanCard /></>); }); await load();
    expect(screen.getByText("周回顾")).toBeTruthy();
    expect(within(screen.getByTestId("hanging-plan-card")).getByText(/查看计划/)).toBeTruthy();
    cleanup(); mocks.review.mockRejectedValueOnce(new Error("失败"));
    await act(async () => { render(<PlanSection />); }); await load();
    expect(screen.getByText("本周训练计划")).toBeTruthy();
  });
  it("未知画像显示指引，其他错误降级为空", async () => {
    mocks.current.mockRejectedValue(new Error("无画像")); mocks.hint.mockReturnValueOnce("先完成基线测评");
    await act(async () => { render(<PlanSection />); }); await load();
    expect(screen.getByText("先完成基线测评")).toBeTruthy();
    cleanup(); mocks.hint.mockReturnValue(null);
    const result = render(<><PlanSection /><HangingPlanCard /></>); await load();
    expect(result.container.textContent).toBe("");
  });
});

it("组件通过真实 API 封装读取计划并提交拒绝动作", async () => {
  const actual = await vi.importActual<typeof import("./plan-api")>("./plan-api");
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    const data = path === "/api/plans/review" ? { review: null } : path === "/api/plans/reject" ? { plan } : { plan, progress };
    return { ok: true, json: async () => ({ success: true, data }), request: init };
  });
  vi.stubGlobal("fetch", fetchMock);
  mocks.current.mockImplementation(actual.fetchCurrentPlan);
  mocks.review.mockImplementation(actual.fetchPlanReview);
  mocks.action.mockImplementation(actual.postPlanAction);
  await act(async () => { render(<PlanSection />); }); await load();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "拒绝本周计划" })); });
  const request = fetchMock.mock.calls.find(([path]) => path === "/api/plans/reject");
  expect(request?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ action: "reject" }) });
  vi.unstubAllGlobals();
});


it("周日回顾归档当前计划后立即显示已归档且不再允许拒绝或撤销", async () => {
  const archived = { ...plan, status: "completed" as const };
  mocks.current.mockResolvedValue({ plan, progress });
  mocks.review.mockResolvedValue({ review: { plan: archived, scoredCount: 1, completedDays: 1, startScore: 50, latestScore: 55, scoreChange: 5 } });
  await act(async () => { render(<PlanSection />); });
  await load();
  expect(screen.getByText("已归档")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "拒绝本周计划" })).toBeNull();
  expect(screen.queryByRole("button", { name: "撤销拒绝" })).toBeNull();
  expect(mocks.action).not.toHaveBeenCalled();
});

it("回顾归档后旧的拒绝请求结束也不能恢复可操作状态", async () => {
  const archived = { ...plan, status: "completed" as const };
  let resolveReview!: (value: unknown) => void;
  let resolveAction!: (value: unknown) => void;
  mocks.current.mockResolvedValue({ plan, progress });
  mocks.review.mockImplementationOnce(() => new Promise((resolve) => { resolveReview = resolve; })).mockResolvedValue({ review: { plan: archived, scoredCount: 1, completedDays: 1, startScore: 50, latestScore: 55, scoreChange: 5 } });
  mocks.action.mockImplementationOnce(() => new Promise((resolve) => { resolveAction = resolve; }));
  await act(async () => { render(<PlanSection />); }); await load();
  fireEvent.click(screen.getByRole("button", { name: "拒绝本周计划" }));
  await act(async () => { resolveReview({ review: { plan: archived, scoredCount: 1, completedDays: 1, startScore: 50, latestScore: 55, scoreChange: 5 } }); });
  await act(async () => { resolveAction({ plan: { ...plan, status: "rejected" } }); });
  expect(screen.getByText("已归档")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "拒绝本周计划" })).toBeNull();
  expect(screen.queryByRole("button", { name: "撤销拒绝" })).toBeNull();
});

it("新周计划与上周回顾并存时保留新计划及其拒绝入口", async () => {
  const current = { ...plan, id: "new-week", weekStartDate: "2026-11-02", focusDimension: "方案设计", reason: "新周方向" };
  const oldPlan = { ...plan, id: "old-week", status: "completed" as const };
  mocks.current.mockResolvedValue({ plan: current, progress });
  mocks.review.mockResolvedValue({ review: { plan: oldPlan, scoredCount: 1, completedDays: 1, startScore: 50, latestScore: 55, scoreChange: 5 } });
  await act(async () => { render(<PlanSection />); }); await load();
  expect(screen.getByText("方案设计 · 弱项")).toBeTruthy();
  expect(screen.getByText("新周方向")).toBeTruthy();
  expect(screen.getByRole("button", { name: "拒绝本周计划" })).toBeTruthy();
  expect(screen.getByText("周回顾")).toBeTruthy();
});
