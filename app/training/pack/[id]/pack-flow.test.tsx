// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PackApiError } from "../api";
import { PackFlow } from "./pack-flow";

const mocks = vi.hoisted(() => ({ get: vi.fn(), start: vi.fn(), abandon: vi.fn(), history: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => { const router = { push: mocks.push, replace: mocks.replace }; return { useRouter: () => router }; });
vi.mock("../api", () => ({ fetchPack: mocks.get, startPackItem: mocks.start, abandonPack: mocks.abandon, PackApiError: class extends Error { constructor(public code: string, message: string) { super(message); } } }));
vi.mock("../../history/api", () => ({ fetchHistoryDetail: mocks.history }));
vi.mock("../../session/shell", () => ({ TodayShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

function pack(states = ["scored", "awaiting_score", "locked", "locked", "locked"]) {
  const tiers = ["basic", "basic", "advanced", "advanced", "challenge"];
  return {
    id: "pack-1", dimension: "问题定义", status: "active", createdAt: "2026-11-03T00:00:00Z", endedAt: null,
    items: states.map((state, orderIndex) => ({
      orderIndex, questionId: `q${orderIndex}`, caseTitle: `案例${orderIndex + 1}`, targetTier: tiers[orderIndex],
      actualTier: orderIndex === 1 ? "advanced" : tiers[orderIndex], actualDifficulty: orderIndex === 1 ? 3 : 1,
      substituted: orderIndex === 1, state, unavailableReason: null,
      sessionId: orderIndex < 2 ? `s${orderIndex}` : null, effectiveScore: state === "scored" ? 60 : null,
    })),
    diagnosis: { trajectory: states.map((state, orderIndex) => ({ orderIndex, effectiveScore: state === "scored" ? 60 : null })), complete: false, average: null, trend: null, band: null, advice: null },
  };
}

it("阶梯显示目标与实际递补，评分中不解锁，已评分题按需展开本人答案和点评", async () => {
  mocks.get.mockResolvedValue(pack());
  mocks.history.mockResolvedValue({ firstAnswer: "初始答案", finalAnswer: "最终答案", feedback: { topIssueText: "缺少证据", nextFocusText: "先验证假设" } });
  render(<PackFlow packId="pack-1" />);
  expect(await screen.findByText("案例1")).toBeTruthy();
  expect(screen.getByRole("link", { name: "查看第 1 题完整反馈" }).getAttribute("href")).toBe("/training/feedback/s0");
  expect(screen.getByText(/基础 2 题 → 进阶 2 题 → 挑战 1 题/)).toBeTruthy();
  expect(screen.getByText(/目标基础.*实际进阶.*递补/)).toBeTruthy();
  expect(screen.getByText("评分中")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "开始第 3 题" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看第 1 题摘要" }));
  expect(await screen.findByText(/最终答案/)).toBeTruthy();
  expect(screen.getByText(/缺少证据/)).toBeTruthy();
  expect(mocks.history).toHaveBeenCalledWith("s0");
  expect(mocks.start).not.toHaveBeenCalled();
});

it("仅已解锁题可开始，返回会话后进入工作台", async () => {
  mocks.get.mockResolvedValue(pack(["available", "locked", "locked", "locked", "locked"]));
  mocks.start.mockResolvedValue({ sessionId: "opened", state: "in_progress" });
  render(<PackFlow packId="pack-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "开始第 1 题" }));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith("pack-1", 0));
  expect(mocks.push).toHaveBeenCalledWith("/training/session/opened");
});

it("开题并发回读已进入评分中时刷新包状态，不误进入作答", async () => {
  mocks.get.mockResolvedValueOnce(pack(["available", "locked", "locked", "locked", "locked"]))
    .mockResolvedValueOnce(pack(["awaiting_score", "locked", "locked", "locked", "locked"]));
  mocks.start.mockResolvedValue({ sessionId: "opened", state: "awaiting_score" });
  render(<PackFlow packId="pack-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "开始第 1 题" }));
  expect(await screen.findByText("评分中")).toBeTruthy();
  expect(mocks.push).not.toHaveBeenCalled();
});

it("放弃前明确保留成绩；取消无写入，确认后展示保留的已评分题", async () => {
  const initial = pack();
  mocks.get.mockResolvedValue(initial);
  mocks.abandon.mockResolvedValue({ ...initial, status: "abandoned" });
  render(<PackFlow packId="pack-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "放弃训练包" }));
  expect(screen.getByText(/已答内容与评分保留/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(mocks.abandon).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "放弃训练包" }));
  fireEvent.click(screen.getByRole("button", { name: "确认放弃" }));
  await waitFor(() => expect(mocks.abandon).toHaveBeenCalledWith("pack-1"));
  expect(await screen.findByText("已放弃")).toBeTruthy();
  expect(within(screen.getByText("案例1").closest("li")!).getByText("60 分")).toBeTruthy();
});

it("完成五题展示逐题有效分与具体建议", async () => {
  const done = pack(["scored", "scored", "scored", "scored", "scored"]);
  mocks.get.mockResolvedValue({ ...done, status: "completed", diagnosis: { trajectory: [50, 60, 70, 80, 90].map((effectiveScore, orderIndex) => ({ orderIndex, effectiveScore })), complete: true, average: 70, trend: "improving", band: "building", advice: "列出判断依据并验证假设" } });
  render(<PackFlow packId="pack-1" />);
  expect(await screen.findByText(/列出判断依据并验证假设/)).toBeTruthy();
  expect(screen.getByText("90")).toBeTruthy();
  expect(screen.getByText("有效分轨迹")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "放弃训练包" })).toBeNull();
});

it("详情错误可重试；基线门禁跳回基线", async () => {
  mocks.get.mockRejectedValueOnce(new Error("训练包暂不可用")).mockResolvedValueOnce(pack());
  const first = render(<PackFlow packId="pack-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "重新加载" }));
  expect(await screen.findByText("案例1")).toBeTruthy();
  first.unmount();
  mocks.get.mockRejectedValueOnce(new PackApiError("BASELINE_REQUIRED", "先完成基线"));
  render(<PackFlow packId="pack-1" />);
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/baseline"));
});

it("已评分摘要失败可重试，长答案截断且缺失项不虚构", async () => {
  mocks.get.mockResolvedValue(pack());
  mocks.history.mockRejectedValueOnce(new Error("历史不可用")).mockResolvedValueOnce({ firstAnswer: null, finalAnswer: "答".repeat(210), feedback: null });
  render(<PackFlow packId="pack-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "查看第 1 题摘要" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "收起第 1 题摘要" }));
  fireEvent.click(screen.getByRole("button", { name: "查看第 1 题摘要" }));
  expect(await screen.findByText(/答{200}…/)).toBeTruthy();
  expect(screen.getAllByText(/暂无记录/).length).toBeGreaterThanOrEqual(2);
});

it("进行中题可继续，不一致和不可用题不可启动；开题失败可见", async () => {
  const data = pack(["in_progress", "inconsistent", "unavailable", "locked", "locked"]);
  mocks.get.mockResolvedValue(data);
  render(<PackFlow packId="pack-1" />);
  expect((await screen.findByRole("link", { name: "继续作答" })).getAttribute("href")).toBe("/training/session/s0");
  expect(screen.getByText("训练状态待恢复")).toBeTruthy();
  expect(screen.getByText("题目暂不可用")).toBeTruthy();
  expect(mocks.start).not.toHaveBeenCalled();
});

it("开题和放弃失败均保留当前包并提示", async () => {
  mocks.get.mockResolvedValue(pack(["available", "locked", "locked", "locked", "locked"]));
  mocks.start.mockRejectedValue(new Error("题目暂不可用"));
  mocks.abandon.mockRejectedValue(new Error("包状态已变化"));
  render(<PackFlow packId="pack-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "开始第 1 题" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "放弃训练包" }));
  fireEvent.click(screen.getByRole("button", { name: "确认放弃" }));
  expect(await screen.findByText("包状态已变化")).toBeTruthy();
});

it("等待评分时自动刷新进度，后继题只有服务端放行后才可开始", async () => {
  vi.useFakeTimers();
  mocks.get.mockResolvedValueOnce(pack()).mockResolvedValueOnce(pack(["scored", "scored", "available", "locked", "locked"]));
  render(<PackFlow packId="pack-1" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.queryByRole("button", { name: "开始第 3 题" })).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByRole("button", { name: "开始第 3 题" })).toBeTruthy();
});

it("放弃成功后迟到的评分轮询不能把已放弃包恢复为进行中", async () => {
  vi.useFakeTimers();
  const active = pack();
  let finishPoll: ((value: object) => void) | undefined;
  mocks.get.mockResolvedValueOnce(active).mockImplementationOnce(() => new Promise((resolve) => { finishPoll = resolve; }));
  mocks.abandon.mockResolvedValue({ ...active, status: "abandoned" });
  render(<PackFlow packId="pack-1" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  fireEvent.click(screen.getByRole("button", { name: "放弃训练包" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "确认放弃" })); });
  expect(screen.getByText("已放弃")).toBeTruthy();
  await act(async () => finishPoll?.(active));
  expect(screen.getByText("已放弃")).toBeTruthy();
});

it("从一个包切换到另一个包时不展示前一包答案，重新展开读取当前会话", async () => {
  const firstPack = pack();
  const secondPack = { ...pack(), id: "pack-2", items: pack().items.map((item, index) => index === 0 ? { ...item, questionId: "new-q", sessionId: "new-s", caseTitle: "新包案例" } : item) };
  mocks.get.mockResolvedValueOnce(firstPack).mockResolvedValueOnce(secondPack);
  mocks.history.mockResolvedValueOnce({ firstAnswer: null, finalAnswer: "旧包答案", feedback: null })
    .mockResolvedValueOnce({ firstAnswer: null, finalAnswer: "新包答案", feedback: null });
  const rendered = render(<PackFlow packId="pack-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "查看第 1 题摘要" }));
  expect(await screen.findByText(/旧包答案/)).toBeTruthy();
  rendered.rerender(<PackFlow packId="pack-2" />);
  expect(screen.queryByText(/旧包答案/)).toBeNull();
  expect(await screen.findByText("新包案例")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "查看第 1 题摘要" }));
  expect(await screen.findByText(/新包答案/)).toBeTruthy();
  expect(mocks.history).toHaveBeenLastCalledWith("new-s");
});

it("换包后不沿用前一包的放弃确认", async () => {
  const firstPack = pack(["available", "locked", "locked", "locked", "locked"]);
  const secondPack = { ...firstPack, id: "pack-2", dimension: "用户理解" };
  mocks.get.mockResolvedValueOnce(firstPack).mockResolvedValueOnce(secondPack);
  const rendered = render(<PackFlow packId="pack-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "放弃训练包" }));
  expect(screen.getByRole("button", { name: "确认放弃" })).toBeTruthy();
  rendered.rerender(<PackFlow packId="pack-2" />);
  expect(await screen.findByText("用户理解 · 专项训练包")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "确认放弃" })).toBeNull();
  expect(screen.getByRole("button", { name: "放弃训练包" })).toBeTruthy();
});

it("前一包加载失败后切换到新包，新包成功时不保留旧错误", async () => {
  mocks.get.mockRejectedValueOnce(new Error("旧包读取失败"))
    .mockResolvedValueOnce({ ...pack(), id: "pack-2", dimension: "用户理解" });
  const rendered = render(<PackFlow packId="pack-1" />);
  expect(await screen.findByText("旧包读取失败")).toBeTruthy();
  rendered.rerender(<PackFlow packId="pack-2" />);
  expect(await screen.findByText("用户理解 · 专项训练包")).toBeTruthy();
  expect(screen.queryByText("旧包读取失败")).toBeNull();
});

it("换包后旧包迟到的开题结果不跳回旧会话", async () => {
  const firstPack = pack(["available", "locked", "locked", "locked", "locked"]);
  const secondPack = { ...firstPack, id: "pack-2", dimension: "用户理解" };
  let finishStart: ((value: object) => void) | undefined;
  mocks.get.mockResolvedValueOnce(firstPack).mockResolvedValueOnce(secondPack);
  mocks.start.mockReturnValueOnce(new Promise((resolve) => { finishStart = resolve; }));
  const rendered = render(<PackFlow packId="pack-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "开始第 1 题" }));
  rendered.rerender(<PackFlow packId="pack-2" />);
  expect(await screen.findByText("用户理解 · 专项训练包")).toBeTruthy();
  await act(async () => finishStart?.({ state: "in_progress", sessionId: "old-session" }));
  expect(mocks.push).not.toHaveBeenCalled();
  expect(screen.getByText("用户理解 · 专项训练包")).toBeTruthy();
});

it("换包后旧包迟到的放弃结果不遮住当前包", async () => {
  const firstPack = pack(["available", "locked", "locked", "locked", "locked"]);
  const secondPack = { ...firstPack, id: "pack-2", dimension: "用户理解" };
  let finishAbandon: ((value: object) => void) | undefined;
  mocks.get.mockResolvedValueOnce(firstPack).mockResolvedValueOnce(secondPack);
  mocks.abandon.mockReturnValueOnce(new Promise((resolve) => { finishAbandon = resolve; }));
  const rendered = render(<PackFlow packId="pack-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "放弃训练包" }));
  fireEvent.click(screen.getByRole("button", { name: "确认放弃" }));
  rendered.rerender(<PackFlow packId="pack-2" />);
  expect(await screen.findByText("用户理解 · 专项训练包")).toBeTruthy();
  await act(async () => finishAbandon?.({ ...firstPack, status: "abandoned" }));
  expect(screen.getByText("用户理解 · 专项训练包")).toBeTruthy();
  expect(screen.queryByText("已放弃")).toBeNull();
});

it("合成验收题在专项包中使用易读标题并保留原始数据", async () => {
  const value = pack(["in_progress", "locked", "locked", "locked", "locked"]);
  value.items[0].caseTitle = "合成验收案例 daily-15";
  mocks.get.mockResolvedValue(value);
  render(<PackFlow packId="pack-1" />);
  expect(await screen.findByText("合成日常案例 16")).toBeTruthy();
  expect(screen.queryByText("合成验收案例 daily-15")).toBeNull();
  expect(value.items[0].caseTitle).toBe("合成验收案例 daily-15");
});
