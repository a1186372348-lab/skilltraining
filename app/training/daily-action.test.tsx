// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DailyTrainingAction } from "./daily-action";

const mocks = vi.hoisted(() => ({ today: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }) }));
vi.mock("./session/api", () => ({ fetchTodaySession: mocks.today, ApiError: class extends Error { constructor(public code: string, message: string) { super(message); } } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); window.history.replaceState({}, "", "/"); });

it("明确选择普通日常时使用 daily 模式，不影响自动推荐入口", async () => {
  mocks.today.mockResolvedValue({ sessionId: "daily-1", kind: "daily" });
  render(<DailyTrainingAction />);
  expect(mocks.today).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "先做日常训练" }));
  await waitFor(() => expect(mocks.today).toHaveBeenCalledWith("daily"));
  expect(mocks.push).toHaveBeenCalledWith("/training/session/daily-1");
});

it("从阶段页携带 mode=daily 进入大厅时真实请求日常，不循环回复测", async () => {
  window.history.replaceState({}, "", "/training?mode=daily");
  mocks.today.mockResolvedValue({ sessionId: "ordinary-1", kind: "daily" });
  render(<DailyTrainingAction />);
  await waitFor(() => expect(mocks.today).toHaveBeenCalledWith("daily"));
  expect(mocks.replace).toHaveBeenCalledWith("/training/session/ordinary-1");
  expect(mocks.push).not.toHaveBeenCalled();
});

it("普通日常遇基线门禁返回基线，其他失败可见并允许重试", async () => {
  const { ApiError } = await import("./session/api");
  mocks.today.mockRejectedValueOnce(new ApiError("BASELINE_REQUIRED", "先完成基线")).mockRejectedValueOnce(new Error("暂时不可用"));
  render(<DailyTrainingAction />);
  fireEvent.click(screen.getByRole("button", { name: "先做日常训练" }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/baseline"));
  fireEvent.click(screen.getByRole("button", { name: "先做日常训练" }));
  expect(await screen.findByText("暂时不可用")).toBeTruthy();
});

it("返回基线会话或评分等待时转基线；无题显示明确空态", async () => {
  const { ApiError } = await import("./session/api");
  mocks.today.mockResolvedValueOnce({ sessionId: "base", kind: "baseline" })
    .mockRejectedValueOnce(new ApiError("BASELINE_SCORING_PENDING", "评分中"))
    .mockResolvedValueOnce(null);
  render(<DailyTrainingAction />);
  fireEvent.click(screen.getByRole("button", { name: "先做日常训练" }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "先做日常训练" }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledTimes(2));
  expect(mocks.push).toHaveBeenLastCalledWith("/baseline");
  fireEvent.click(screen.getByRole("button", { name: "先做日常训练" }));
  expect(await screen.findByText(/今日暂无可用训练/)).toBeTruthy();
});
