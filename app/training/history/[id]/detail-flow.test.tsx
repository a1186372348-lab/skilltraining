// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HistoryDetailFlow } from "./detail-flow";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../api", () => ({ fetchHistoryDetail: mocks.fetch }));
vi.mock("../shell", () => ({ HistoryShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const baseline = {
  sessionId: "baseline", date: "2026-10-03", isExtra: true, questionKind: "baseline", state: "followup",
  caseTitle: "基线回放案例", caseBackground: {}, mainQuestion: "如何判断？", abilityTags: ["用户理解"], difficulty: 2,
  firstAnswer: "首答内容", firstSubmittedAt: "2026-10-03T06:00:00Z", finalAnswer: "终答内容", finalSubmittedAt: "2026-10-03T07:00:00Z",
  hintCount: 1, hintEvents: [{ layer: 1, requestedAt: "2026-10-03T06:30:00Z" }],
  followups: [{ round: 1, question: "你的依据是什么？" }],
  scores: [{ dimension: "用户理解", rawScore: 80, hintCount: 1, coefficient: 0.9, effectiveScore: 72, diagnosisText: "需补依据" }],
  feedback: { topIssueText: "需要证据", nextFocusText: "列出指标" }, missing: [],
};

it("回放所选基线会话，状态为评分中并保留答案与各分区", async () => {
  mocks.fetch.mockResolvedValue(baseline);
  render(<HistoryDetailFlow sessionId="baseline" />);
  expect(await screen.findByText("基线回放案例")).toBeTruthy();
  expect(mocks.fetch).toHaveBeenCalledWith("baseline");
  expect(screen.getByText(/评分中 · 基线/)).toBeTruthy();
  expect(screen.queryByText(/评分中 · 加练/)).toBeNull();
  for (const text of ["首答内容", "终答内容", "你的依据是什么？", "需要证据", "列出指标"]) expect(screen.getByText(text)).toBeTruthy();
});

it("回放不可用时支持重试；无评分或反馈显示正常空态", async () => {
  mocks.fetch.mockRejectedValueOnce(new Error("训练记录不存在")).mockResolvedValueOnce({ ...baseline, firstAnswer: null, firstSubmittedAt: null, finalAnswer: null, finalSubmittedAt: null, hintCount: 0, hintEvents: [], followups: [], scores: [], feedback: null, missing: [] });
  render(<HistoryDetailFlow sessionId="baseline" />);
  expect(await screen.findByText("训练记录不存在")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  expect(await screen.findByText("本次训练尚未评分")).toBeTruthy();
  expect(screen.getByText("本次训练尚未生成反馈")).toBeTruthy();
});

it("日常加练缺失数据时标记缺失，保留案例来源", async () => {
  mocks.fetch.mockResolvedValue({ ...baseline, questionKind: "daily", state: "scored", firstAnswer: null, finalAnswer: null, scores: [], feedback: null, missing: ["firstAnswer", "finalAnswer", "scores", "feedback"], caseBackground: { product: { text: "真实产品", citations: [1] }, case_sources: [{ id: 1, title: "来源", publisher: "官方", url: "https://example.com" }] } });
  render(<HistoryDetailFlow sessionId="daily" />);
  expect(await screen.findByText("真实产品")).toBeTruthy();
  expect(screen.getByRole("link", { name: "原文" }).getAttribute("href")).toBe("https://example.com");
  expect(screen.getByText(/已完成 · 加练/)).toBeTruthy();
  expect(screen.getByText("评分记录缺失")).toBeTruthy();
  expect(screen.getByText("反馈记录缺失")).toBeTruthy();
  expect(screen.getAllByText("记录缺失").length).toBeGreaterThan(0);
});
