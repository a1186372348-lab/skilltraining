// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import HomePage from "../page";
import { HomeDashboard } from "./home-dashboard";

const mocks = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => { const router = { replace: mocks.replace }; return { useRouter: () => router }; });
vi.mock("./home-shell", () => ({ HomeShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/app/_shared/plan-cards", () => ({ HangingPlanCard: () => null }));
vi.mock("./campaign-map", () => ({ CampaignMap: () => <section>你的成长战役地图</section> }));
vi.mock("@/app/training/current-training-card", () => ({ CurrentTrainingCard: ({ onChanged }: { onChanged: () => void }) => <button onClick={onChanged}>更新训练</button> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it.each([
  ["标准错误响应", () => Response.json({ success: false, error: { code: "UNAUTHORIZED", message: "未登录或登录已过期" } }, { status: 401 })],
  ["无 JSON 正文", () => new Response(null, { status: 401 })],
] as const)("打开首页时收到 401（%s）直接进入登录页", async (_description, response) => {
  const fetchMock = vi.fn().mockResolvedValue(response());
  vi.stubGlobal("fetch", fetchMock);

  render(<HomePage />);

  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/login"));
  expect(screen.queryByRole("button", { name: "重新加载" })).toBeNull();
  expect(fetchMock).toHaveBeenCalledOnce();
});

it("首页遇到基线未完成时跳回基线，不显示评分", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ success: false, error: { code: "BASELINE_REQUIRED", message: "请先完成基线测评" } }) }));
  render(<HomeDashboard />);
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/baseline"));
  expect(screen.queryByText("73")).toBeNull();
});

it("普通加载错误可重试，完成用户可看到自己的分数与诊断", async () => {
  const data = {
    todayDateKey: "2026-11-03", stats: { streakDays: 1, weekTrainedCount: 1, weekDays: [{ dateKey: "2026-11-03", weekday: 2, trained: true, isToday: true, isFuture: false }] },
    currentTraining: { kind: "not_started", dateKey: "2026-11-03" },
    ability: { unlockedCount: 1, totalCount: 2, observed: [{ dimension: "用户理解", score: 73, trend: "上升" }], unobserved: ["问题定义"] },
    latestDiagnosis: { sessionId: "s", text: "补充验证依据", dateKey: "2026-11-03" },
  };
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: { code: "OTHER", message: "暂时无法加载" } }) }).mockResolvedValue({ ok: true, json: async () => ({ success: true, data }) });
  vi.stubGlobal("fetch", fetchMock);
  render(<HomePage />);
  expect(await screen.findByText("暂时无法加载")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  expect(await screen.findByText("用户理解")).toBeTruthy();
  expect(screen.getByText("你的成长战役地图")).toBeTruthy();
  expect(screen.getByText("73")).toBeTruthy();
  expect(screen.getByText("问题定义")).toBeTruthy();
  expect(screen.getByText(/补充验证依据/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "更新训练" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
});

it("单卡数据暂不可用时显示空态，可重新加载", async () => {
  const data = { todayDateKey: "2026-11-03", stats: null, currentTraining: null, ability: null, latestDiagnosis: null };
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data }) });
  vi.stubGlobal("fetch", fetchMock);
  render(<HomeDashboard />);
  expect(await screen.findByText("今日训练暂未就绪")).toBeTruthy();
  expect(screen.getByText("统计数据暂时不可用")).toBeTruthy();
  expect(screen.getByText("能力总览暂时不可用")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});

it("首页刷新时登录已失效，清除之前显示的训练数据并进入登录页", async () => {
  const data = {
    todayDateKey: "2026-11-03", stats: null, currentTraining: null, ability: null,
    latestDiagnosis: { sessionId: "s", text: "补充验证依据", dateKey: "2026-11-03" },
  };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ success: true, data }))
    .mockResolvedValueOnce(new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<HomePage />);
  expect(await screen.findByText(/补充验证依据/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));

  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/login"));
  expect(screen.queryByText(/补充验证依据/)).toBeNull();
});
