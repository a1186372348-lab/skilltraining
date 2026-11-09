// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PackCard } from "./pack-card";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./api", () => ({ fetchActivePack: mocks.fetch }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

it("包卡加载失败可重试，数据异常提示待恢复而非虚报解锁", async () => {
  mocks.fetch.mockRejectedValueOnce(new Error("失败")).mockResolvedValueOnce({ id: "p", dimension: "根因分析", items: [{ state: "scored" }, { state: "inconsistent" }] });
  render(<PackCard />);
  fireEvent.click(await screen.findByRole("button", { name: "重试" }));
  expect(await screen.findByText(/状态待恢复/)).toBeTruthy();
  expect(screen.getByRole("link", { name: /继续攻坚/ }).getAttribute("href")).toBe("/training/pack/p");
});

it("没有进行中训练包时不显示卡片", async () => {
  mocks.fetch.mockResolvedValue(null);
  render(<PackCard />);
  await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
  expect(screen.queryByRole("link", { name: /继续攻坚/ })).toBeNull();
});

it("评分中自动刷新，评分后更新已完成题数", async () => {
  vi.useFakeTimers();
  const base = { id: "p", dimension: "根因分析", status: "active" };
  mocks.fetch.mockResolvedValueOnce({ ...base, items: [{ state: "scored" }, { state: "awaiting_score" }] })
    .mockResolvedValueOnce({ ...base, items: [{ state: "scored" }, { state: "scored" }, { state: "available" }] });
  render(<PackCard />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText(/评分中/)).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByText(/已完成 2\/5/)).toBeTruthy();
  expect(screen.queryByText(/评分中/)).toBeNull();
});

it("评分刷新失败不展示过期进度，并提供重试", async () => {
  vi.useFakeTimers();
  mocks.fetch.mockResolvedValueOnce({ id: "p", dimension: "根因分析", status: "active", items: [{ state: "awaiting_score" }] })
    .mockRejectedValueOnce(new Error("不可用"));
  render(<PackCard />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByText(/训练包状态暂不可用/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
});
