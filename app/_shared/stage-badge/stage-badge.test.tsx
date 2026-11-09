// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StageProvider, useStageOverview } from "./stage-provider";
import { StageBadge } from "./stage-badge";

const mocks = vi.hoisted(() => ({ overview: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("@/app/stages/api", () => ({ fetchStageOverview: mocks.overview, StageApiError: class extends Error { constructor(public code: string, message: string) { super(message); } } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); window.history.replaceState({}, "", "/"); });

it("同一阶段事实同时供宽屏与窄屏标识使用", async () => {
  mocks.overview.mockResolvedValue({ stage: "exploration", baselineCompleted: true, dimensions: [{ dimension: "用户理解", status: "pending" }], timeline: [] });
  render(<StageProvider><StageBadge /><StageBadge compact /></StageProvider>);
  expect(await screen.findAllByText("探索期")).toHaveLength(2);
  expect(screen.getAllByText(/待复测/)).toHaveLength(2);
  expect(mocks.overview).toHaveBeenCalledTimes(1);
});

it("阶段读取失败不挡住普通内容，基线门禁仍转基线", async () => {
  const { StageApiError } = await import("@/app/stages/api");
  mocks.overview.mockRejectedValueOnce(new Error("暂不可用")).mockRejectedValueOnce(new StageApiError("BASELINE_REQUIRED", "先完成基线"));
  const first = render(<StageProvider><StageBadge /><p>普通训练仍可用</p></StageProvider>);
  expect(await screen.findByText("普通训练仍可用")).toBeTruthy();
  await waitFor(() => expect(mocks.overview).toHaveBeenCalledTimes(1));
  first.unmount();
  render(<StageProvider><StageBadge /></StageProvider>);
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/baseline"));
});

it("基线页自身遇到未完成门禁时不反复跳回当前地址", async () => {
  const { StageApiError } = await import("@/app/stages/api");
  window.history.replaceState({}, "", "/baseline");
  mocks.overview.mockRejectedValue(new StageApiError("BASELINE_REQUIRED", "先完成基线"));
  render(<StageProvider><StageBadge /><p>基线作答</p></StageProvider>);
  await waitFor(() => expect(mocks.overview).toHaveBeenCalledTimes(1));
  expect(screen.getByText("基线作答")).toBeTruthy();
  expect(mocks.replace).not.toHaveBeenCalled();
});

it("未完成基线提示先完成；无待决复测时显示阶段进度入口", async () => {
  mocks.overview.mockResolvedValueOnce({ stage: "exploration", baselineCompleted: false, dimensions: [], timeline: [] })
    .mockResolvedValueOnce({ stage: "strengthening", baselineCompleted: true, dimensions: [], timeline: [] });
  const first = render(<StageProvider><StageBadge /></StageProvider>);
  expect(await screen.findByText("先完成基线测评")).toBeTruthy();
  first.unmount();
  render(<StageProvider><StageBadge /></StageProvider>);
  expect(await screen.findByText("强化期")).toBeTruthy();
  expect(screen.getByText("查看成长进度 →")).toBeTruthy();
});

it("重新读取后迟到的旧请求不能覆盖最新阶段", async () => {
  let resolveOld: ((value: object) => void) | undefined;
  mocks.overview.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValueOnce({ stage: "strengthening", baselineCompleted: true, dimensions: [], timeline: [] });
  function Retry() { const { refresh } = useStageOverview(); return <button onClick={refresh}>刷新阶段</button>; }
  render(<StageProvider><StageBadge /><Retry /></StageProvider>);
  await waitFor(() => expect(mocks.overview).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "刷新阶段" }));
  expect(await screen.findByText("强化期")).toBeTruthy();
  await act(async () => resolveOld?.({ stage: "exploration", baselineCompleted: true, dimensions: [], timeline: [] }));
  expect(screen.getByText("强化期")).toBeTruthy();
  expect(screen.queryByText("探索期")).toBeNull();
});

it("已卸载页面的迟到基线错误不会触发跳转", async () => {
  let rejectOld: ((reason: unknown) => void) | undefined;
  const { StageApiError } = await import("@/app/stages/api");
  mocks.overview.mockReturnValue(new Promise((_resolve, reject) => { rejectOld = reject; }));
  const rendered = render(<StageProvider><StageBadge /></StageProvider>);
  await waitFor(() => expect(mocks.overview).toHaveBeenCalledTimes(1));
  rendered.unmount();
  await act(async () => rejectOld?.(new StageApiError("BASELINE_REQUIRED", "先完成基线")));
  expect(mocks.replace).not.toHaveBeenCalled();
});
