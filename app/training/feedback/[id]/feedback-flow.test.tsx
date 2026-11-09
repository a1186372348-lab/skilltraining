// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { FeedbackFlow } from "./feedback-flow";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), push: vi.fn(), survey: vi.fn(), extra: vi.fn() }));
vi.mock("next/navigation", () => { const router = { push: mocks.push }; return { useRouter: () => router }; });
vi.mock("./api", () => ({ fetchFeedback: mocks.fetch, submitSurvey: mocks.survey }));
vi.mock("../../session/api", () => ({ startExtraSession: mocks.extra, ApiError: class extends Error { code = ""; } }));
vi.mock("../../session/shell", () => ({ TodayShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

it("反馈逐维显示本次 AI 自评信心，NULL 隐藏且 0 可见", async () => {
  const score = (dimension: string, confidence: number | null) => ({ dimension, confidence, rawScore: 70, hintCount: 0, coefficient: 1, effectiveScore: 70, diagnosisText: "补充证据" });
  mocks.fetch.mockResolvedValue({ status: "ready", sessionId: "session", questionKind: "daily", scores: [score("用户理解", 0), score("根因分析", 78), score("产品取舍", null)], topIssueText: "需要补充依据", nextFocusText: "写出验证方法", survey: { submitted: true, needsPeriodicQ3: false } });
  render(<FeedbackFlow sessionId="session" />);
  const zero = (await screen.findByText("用户理解")).closest("li")!;
  expect(within(zero).getByText("本次评分信心：0/100（AI 自评）")).toBeTruthy();
  fireEvent.click(within(zero).getByRole("button", { name: "查看计算过程" }));
  expect(within(zero).getByText("诊断：补充证据")).toBeTruthy();
  expect(within(screen.getByText("根因分析").closest("li")!).getByText("本次评分信心：78/100（AI 自评）")).toBeTruthy();
  expect(within(screen.getByText("产品取舍").closest("li")!).queryByText(/评分信心/)).toBeNull();
  expect(screen.queryByText(/准确率/)).toBeNull();
});

it("反馈问卷失败可重试，成功后仍可创建加练", async () => {
  mocks.fetch.mockResolvedValue({ status: "ready", sessionId: "session", questionKind: "daily", scores: [], topIssueText: "需要补充依据", nextFocusText: "写出验证方法", survey: { submitted: false, needsPeriodicQ3: false } });
  mocks.survey.mockRejectedValueOnce(new Error("提交失败"));
  mocks.survey.mockResolvedValueOnce({});
  mocks.extra.mockResolvedValue({ sessionId: "extra" });
  render(<FeedbackFlow sessionId="session" />);
  const groups = await screen.findAllByRole("radiogroup");
  fireEvent.click(within(groups[0]).getByRole("radio", { name: "4 星" }));
  fireEvent.click(within(groups[1]).getByRole("radio", { name: "5 星" }));
  fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));
  expect(await screen.findByText(/提交失败（反馈内容不受影响/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));
  expect(await screen.findByText("已收到你的反馈")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "再练一题" }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/training/session/extra"));
});

it("基线反馈只有回基线入口；评分中稍后刷新为结果", async () => {
  vi.useFakeTimers();
  mocks.fetch.mockResolvedValueOnce({ status: "scoring", sessionId: "session" }).mockResolvedValueOnce({ status: "ready", sessionId: "session", questionKind: "baseline", scores: [], topIssueText: "改进依据", nextFocusText: "写指标", survey: { submitted: true, needsPeriodicQ3: false } });
  render(<FeedbackFlow sessionId="session" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText("总监评分中…")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByRole("link", { name: "回到基线测评" }).getAttribute("href")).toBe("/baseline");
  expect(screen.queryByRole("button", { name: "再练一题" })).toBeNull();
});

it("评分轮询持续失败时提供重试，恢复后可显示反馈", async () => {
  vi.useFakeTimers();
  mocks.fetch.mockRejectedValue(new Error("暂时无法加载"));
  render(<FeedbackFlow sessionId="session" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(12001); });
  expect(screen.getByText("暂时无法加载")).toBeTruthy();
  mocks.fetch.mockResolvedValue({ status: "ready", sessionId: "session", questionKind: "daily", scores: [], topIssueText: "恢复后内容", nextFocusText: "写指标", survey: { submitted: true, needsPeriodicQ3: false } });
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText("恢复后内容")).toBeTruthy();
});

it("加练失败时保留反馈并提示，基线门禁则引导回基线", async () => {
  mocks.fetch.mockResolvedValue({ status: "ready", sessionId: "session", questionKind: "daily", scores: [], topIssueText: "保留反馈", nextFocusText: "写指标", survey: { submitted: true, needsPeriodicQ3: false } });
  const { ApiError } = await import("../../session/api");
  const baselineError = Object.assign(new ApiError("BASELINE_REQUIRED", "需基线"), { code: "BASELINE_REQUIRED" });
  mocks.extra.mockRejectedValueOnce(new Error("加练暂不可用")).mockRejectedValueOnce(baselineError);
  render(<FeedbackFlow sessionId="session" />);
  await screen.findByText("保留反馈");
  fireEvent.click(screen.getByRole("button", { name: "再练一题" }));
  expect(await screen.findByText("加练暂不可用")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "再练一题" }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/baseline"));
});
