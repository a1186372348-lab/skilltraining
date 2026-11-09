// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CurrentTrainingCard } from "./current-training-card";
import { ApiError } from "./session/api";

const mocks = vi.hoisted(() => ({ abandon: vi.fn(), abandonPack: vi.fn(), today: vi.fn(), extra: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("./session/api", () => ({
  abandonSession: mocks.abandon, fetchTodaySession: mocks.today, startExtraSession: mocks.extra,
  ApiError: class extends Error { constructor(public code: string, message: string) { super(message); } },
}));
vi.mock("./pack/api", () => ({ abandonPackSession: mocks.abandonPack }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const pack = { kind: "in_progress", sessionId: "pack-session", caseTitle: "专项题", stage: "answering", sourceType: "pack" } as const;

it("包题取消重启不写入；明确告知整包放弃与成绩保留", () => {
  render(<CurrentTrainingCard current={pack} />);
  expect(screen.getByText("专项训练包")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重启训练" }));
  expect(screen.getByText(/终止本题会放弃整个训练包，已答内容与评分保留/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(mocks.abandon).not.toHaveBeenCalled();
  expect(mocks.abandonPack).not.toHaveBeenCalled();
});

it("包题明确确认后才携带确认字段；普通训练仍保留原调用", async () => {
  mocks.abandon.mockResolvedValue({ state: "abandoned" });
  mocks.abandonPack.mockResolvedValue({ state: "abandoned" });
  const changed = vi.fn();
  const first = render(<CurrentTrainingCard current={pack} onChanged={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "重启训练" }));
  fireEvent.click(screen.getByRole("button", { name: "确认重启" }));
  await waitFor(() => expect(mocks.abandonPack).toHaveBeenCalledWith("pack-session"));
  expect(mocks.abandon).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalled();
  first.unmount();
  render(<CurrentTrainingCard current={{ kind: "in_progress", sessionId: "daily", caseTitle: "日常题", stage: "followup" }} />);
  fireEvent.click(screen.getByRole("button", { name: "重启训练" }));
  expect(screen.getByText("丢弃当前作答并重启？")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "确认重启" }));
  await waitFor(() => expect(mocks.abandon).toHaveBeenCalledWith("daily"));
});

it("评分中和已完成会话不提供终止入口", () => {
  const first = render(<CurrentTrainingCard current={{ ...pack, stage: "scoring" }} />);
  expect(screen.queryByRole("button", { name: "重启训练" })).toBeNull();
  first.unmount();
  render(<CurrentTrainingCard current={{ kind: "completed", sessionId: "done", caseTitle: "已完成", scores: [], sourceType: "pack" }} />);
  expect(screen.queryByRole("button", { name: "重启训练" })).toBeNull();
  expect(screen.getByText("专项训练包已完成")).toBeTruthy();
});

it("今日入口正确进入基线或每日训练，错误可见", async () => {
  mocks.today.mockResolvedValueOnce({ sessionId: "daily", kind: "daily" }).mockResolvedValueOnce({ sessionId: "base", kind: "baseline" }).mockRejectedValueOnce(new Error("训练暂不可用"));
  const current = { kind: "not_started", dateKey: "2026-11-03" } as const;
  const first = render(<CurrentTrainingCard current={current} />);
  fireEvent.click(screen.getByRole("button", { name: /开始今日训练/ }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/training/session/daily"));
  first.unmount();
  const second = render(<CurrentTrainingCard current={current} />);
  fireEvent.click(screen.getByRole("button", { name: /开始今日训练/ }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/baseline"));
  second.unmount();
  render(<CurrentTrainingCard current={current} />);
  fireEvent.click(screen.getByRole("button", { name: /开始今日训练/ }));
  expect(await screen.findByText("训练暂不可用")).toBeTruthy();
});

it("完成卡可查看分数、进入加练；包题终止失败可见且能取消", async () => {
  mocks.extra.mockResolvedValue({ sessionId: "extra" });
  const first = render(<CurrentTrainingCard current={{ kind: "completed", sessionId: "done", caseTitle: "已完成", scores: [{ dimension: "用户理解", effectiveScore: 73 }] }} />);
  expect(screen.getByText("用户理解")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /再练一题/ }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/training/session/extra"));
  first.unmount();
  mocks.abandonPack.mockRejectedValue(new Error("状态已经改变"));
  render(<CurrentTrainingCard current={pack} />);
  fireEvent.click(screen.getByRole("button", { name: "重启训练" }));
  fireEvent.click(screen.getByRole("button", { name: "确认重启" }));
  expect(await screen.findByText("状态已经改变")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByText("状态已经改变")).toBeNull();
});

it("基线评分中和加练门禁都返回基线；今日空结果可见提示", async () => {
  const current = { kind: "not_started", dateKey: "2026-11-03" } as const;
  mocks.today.mockRejectedValueOnce(new ApiError("BASELINE_SCORING_PENDING", "等待评分"));
  const first = render(<CurrentTrainingCard current={current} />);
  fireEvent.click(screen.getByRole("button", { name: /开始今日训练/ }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/baseline"));
  first.unmount();
  mocks.today.mockResolvedValueOnce(null);
  const second = render(<CurrentTrainingCard current={current} />);
  fireEvent.click(screen.getByRole("button", { name: /开始今日训练/ }));
  expect(await screen.findByText("今日训练暂未就绪，请稍后重试")).toBeTruthy();
  second.unmount();
  mocks.extra.mockRejectedValueOnce(new ApiError("BASELINE_REQUIRED", "先完成基线"));
  render(<CurrentTrainingCard current={{ kind: "completed", sessionId: "s", caseTitle: "完成", scores: [] }} />);
  fireEvent.click(screen.getByRole("button", { name: /再练一题/ }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledTimes(2));
});
