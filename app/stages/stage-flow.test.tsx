// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StageProvider } from "@/app/_shared/stage-badge/stage-provider";
import { StageFlow } from "./stage-flow";
import type { StageOverview } from "./contract";

const mocks = vi.hoisted(() => ({ overview: vi.fn(), start: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }) }));
vi.mock("./api", () => ({ fetchStageOverview: mocks.overview, startRetest: mocks.start, StageApiError: class extends Error { constructor(public code: string, message: string) { super(message); } } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function data(): StageOverview {
  return {
    stage: "exploration", baselineCompleted: true,
    dimensions: [
      { dimension: "问题定义", observed: false, status: "unverified", consecutive: null, triggerId: null, activeSessionId: null, activeSessionStatus: null, reason: null },
      { dimension: "用户理解", observed: true, status: "pending", consecutive: 3, triggerId: "trigger-a", activeSessionId: null, activeSessionStatus: null, reason: null },
      { dimension: "产品取舍", observed: true, status: "pending", consecutive: 3, triggerId: "trigger-b", activeSessionId: "session-b", activeSessionStatus: "awaiting_score", reason: null },
      { dimension: "价值判断", observed: true, status: "suspended", consecutive: 3, triggerId: "trigger-c", activeSessionId: null, activeSessionStatus: null, reason: "no_candidate" },
    ],
    timeline: [{ id: "event-a", dimension: "用户理解", type: "retest_trigger", createdAt: "2026-11-03T00:00:00Z", resultEffectiveScore: null }],
  };
}

it("探索期仍展示各维待复测、评分中和挂起，以及准确触发和通过线", async () => {
  mocks.overview.mockResolvedValue(data());
  render(<StageProvider><StageFlow /></StageProvider>);
  expect(await screen.findByText("用户理解 · 换题复测")).toBeTruthy();
  expect(screen.getAllByText(/连续 3 次有效分 ≥75/).length).toBeGreaterThan(0);
  expect(screen.getByText(/复测有效分 ≥60/)).toBeTruthy();
  expect(screen.getByText("评分中")).toBeTruthy();
  expect(screen.getByText(/暂无可用题/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "先做日常训练" }).getAttribute("href")).toBe("/training?mode=daily");
  expect(screen.getByText(/用户理解.*复测已触发/)).toBeTruthy();
});

it("仅开始指定维度并按服务端会话进入，不把评分中会话重复开题", async () => {
  mocks.overview.mockResolvedValue(data());
  mocks.start.mockResolvedValue({ state: "ready", triggerId: "trigger-a", sessionId: "session-a", dimension: "用户理解", sessionState: "reading", awaitingScore: false });
  render(<StageProvider><StageFlow /></StageProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "开始用户理解复测" }));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith("trigger-a"));
  expect(mocks.push).toHaveBeenCalledWith("/training/session/session-a");
  expect(screen.queryByRole("button", { name: "开始产品取舍复测" })).toBeNull();
});

it("无完成标记时提示先完成基线，不能发起复测", async () => {
  mocks.overview.mockResolvedValue({ ...data(), baselineCompleted: false });
  render(<StageProvider><StageFlow /></StageProvider>);
  expect(await screen.findByText(/完成基线测评后可开始复测/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "开始用户理解复测" }) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.start).not.toHaveBeenCalled();
});

it("异常缺失会话状态时不猜可继续，未完成基线时连旧会话入口也禁用", async () => {
  const value = data();
  value.dimensions[1] = { ...value.dimensions[1], activeSessionId: "uncertain", activeSessionStatus: null };
  mocks.overview.mockResolvedValueOnce(value).mockResolvedValueOnce({ ...value, baselineCompleted: false, dimensions: value.dimensions.map((item) => item.dimension === "用户理解" ? { ...item, activeSessionStatus: "in_progress" } : item) });
  const first = render(<StageProvider><StageFlow /></StageProvider>);
  expect(await screen.findByText(/会话状态待恢复/)).toBeTruthy();
  expect(screen.queryByRole("link", { name: "继续复测" })).toBeNull();
  first.unmount();
  render(<StageProvider><StageFlow /></StageProvider>);
  expect(await screen.findByText(/完成基线测评后可开始复测/)).toBeTruthy();
  expect(screen.queryByRole("link", { name: "继续复测" })).toBeNull();
});

it("进行中的复测可恢复；维度损坏只提示恢复，不阻止其他维度", async () => {
  const value = data();
  value.dimensions[1] = { ...value.dimensions[1], activeSessionId: "resume", activeSessionStatus: "in_progress" };
  value.dimensions.push({ dimension: "需求分析", observed: true, status: "needs_recovery", consecutive: null, triggerId: "trigger-d", activeSessionId: null, activeSessionStatus: null, reason: "invalid_score" });
  value.dimensions.push({ dimension: "数据判断", observed: true, status: "verified", consecutive: null, triggerId: null, activeSessionId: null, activeSessionStatus: null, reason: null });
  value.dimensions.push({ dimension: "方案设计", observed: true, status: "needs_practice", consecutive: null, triggerId: null, activeSessionId: null, activeSessionStatus: null, reason: null });
  mocks.overview.mockResolvedValue(value);
  render(<StageProvider><StageFlow /></StageProvider>);
  const resume = await screen.findByRole("link", { name: "继续复测" });
  expect(resume.getAttribute("href")).toBe("/training/session/resume");
  expect(screen.getByText("复测评分暂不可用，请稍后重试。")).toBeTruthy();
  expect(screen.getByText("已通过")).toBeTruthy();
  expect(screen.getByText("复测未通过 · 继续强化")).toBeTruthy();
});

it("尚未触发的已观察维度显示连续达标进度，未知维度保持待探索", async () => {
  const value = data();
  value.dimensions = [
    { dimension: "用户理解", observed: true, status: "unverified", consecutive: 2, triggerId: null, activeSessionId: null, activeSessionStatus: null, reason: null },
    { dimension: "问题定义", observed: false, status: "unverified", consecutive: null, triggerId: null, activeSessionId: null, activeSessionStatus: null, reason: null },
  ];
  mocks.overview.mockResolvedValue(value);
  render(<StageProvider><StageFlow /></StageProvider>);
  const observed = (await screen.findByText("用户理解 · 训练进度")).closest("article")!;
  expect(within(observed).getByText(/连续达标 2\/3/)).toBeTruthy();
  expect(within(observed).queryByRole("button")).toBeNull();
  const unknown = screen.getByText("问题定义 · 训练进度").closest("article")!;
  expect(within(unknown).getByText("待探索")).toBeTruthy();
});

it.each([
  [{ state: "suspended", reason: "reserved_by_pack" }, "可用题已由训练包预留"],
  [{ state: "needs_recovery", reason: "session_missing" }, "复测会话暂不可用"],
  [{ state: "settled", outcome: "pass", sessionId: "old" }, "本次复测已结算"],
])("服务端返回 %s 后提示真实状态并重新读取", async (response, text) => {
  mocks.overview.mockResolvedValue(data());
  mocks.start.mockResolvedValue({ ...response, triggerId: "trigger-a", dimension: "用户理解" });
  render(<StageProvider><StageFlow /></StageProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "开始用户理解复测" }));
  expect(await screen.findByText(new RegExp(text))).toBeTruthy();
  await waitFor(() => expect(mocks.overview).toHaveBeenCalledTimes(2));
  expect(mocks.push).not.toHaveBeenCalled();
});

it("开题竞态发现已提交终答时转反馈；其他错误可见，基线错误回基线", async () => {
  const { StageApiError } = await import("./api");
  mocks.overview.mockResolvedValue(data());
  mocks.start.mockResolvedValueOnce({ state: "ready", sessionId: "waiting", awaitingScore: true })
    .mockRejectedValueOnce(new Error("暂时无法开始"))
    .mockRejectedValueOnce(new StageApiError("BASELINE_REQUIRED", "先完成基线"));
  render(<StageProvider><StageFlow /></StageProvider>);
  const button = await screen.findByRole("button", { name: "开始用户理解复测" });
  fireEvent.click(button);
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/training/feedback/waiting"));
  fireEvent.click(button);
  expect(await screen.findByText("暂时无法开始")).toBeTruthy();
  fireEvent.click(button);
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/baseline"));
});

it("阶段加载错误可重试，恢复后展示阶段；无触发时显示空态", async () => {
  mocks.overview.mockRejectedValueOnce(new Error("阶段暂不可用")).mockResolvedValueOnce({ ...data(), dimensions: [], timeline: [] });
  render(<StageProvider><StageFlow /></StageProvider>);
  expect(await screen.findByText("阶段暂不可用")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  expect(await screen.findByText(/持续训练后/)).toBeTruthy();
  const timeline = screen.getByText("成长时间线").closest("section")!;
  expect(within(timeline).getByText(/记录在这里/)).toBeTruthy();
});
