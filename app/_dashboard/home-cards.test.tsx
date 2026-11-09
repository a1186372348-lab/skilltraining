// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HomePlanCard } from "./home-plan-card";
import { HomePackCard } from "./home-pack-card";

const mocks = vi.hoisted(() => ({ plan: vi.fn(), active: vi.fn(), hub: vi.fn(), pack: vi.fn() }));
vi.mock("@/app/_shared/plan-api", () => ({ fetchCurrentPlan: mocks.plan }));
vi.mock("@/app/training/pack/api", () => ({ fetchActivePack: mocks.active, fetchPack: mocks.pack }));
vi.mock("@/app/training/api", () => ({ fetchTrainingHub: mocks.hub }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("计划卡以服务端拒绝状态呈现，并保留管理及周回顾入口", async () => {
  mocks.plan.mockResolvedValue({ plan: { focusDimension: "用户理解", status: "rejected", reason: "本周选择此维度" }, progress: { completedDays: 2, scoredCount: 2 } });
  render(<HomePlanCard />);
  expect(await screen.findByText(/已拒绝/)).toBeTruthy();
  expect(screen.getByText(/用户理解/)).toBeTruthy();
  expect(screen.getByRole("link", { name: /管理计划与周回顾/ }).getAttribute("href")).toBe("/training");
});

it("包卡展示评分中进度，完成后可从本人历史重新进入诊断", async () => {
  mocks.active.mockResolvedValueOnce({ id: "active", dimension: "问题定义", status: "active", items: [{ state: "scored" }, { state: "awaiting_score" }] }).mockResolvedValueOnce(null);
  const first = render(<HomePackCard />);
  expect(await screen.findByText(/已完成 1\/5.*评分中/)).toBeTruthy();
  first.unmount();
  mocks.hub.mockResolvedValue({ history: [{ sourceType: "pack", sourceId: "11111111-1111-4111-8111-111111111111" }] });
  mocks.pack.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", dimension: "问题定义", status: "completed", items: Array.from({ length: 5 }, () => ({ state: "scored" })) });
  render(<HomePackCard />);
  expect(await screen.findByText(/训练包已完成/)).toBeTruthy();
  expect(screen.getByRole("link", { name: /查看包诊断/ }).getAttribute("href")).toBe("/training/pack/11111111-1111-4111-8111-111111111111");
});

it("无计划与计划读取失败各自显示可理解状态", async () => {
  mocks.plan.mockResolvedValueOnce({ plan: null, progress: null }).mockRejectedValueOnce(new Error("暂不可用"));
  const first = render(<HomePlanCard />);
  expect(await screen.findByText(/暂无本周计划/)).toBeTruthy();
  first.unmount();
  render(<HomePlanCard />);
  expect(await screen.findByText(/计划暂不可用/)).toBeTruthy();
});

it("进行中或归档计划展示服务端状态和进度，不虚构周进度", async () => {
  mocks.plan.mockResolvedValueOnce({ plan: { focusDimension: "问题定义", status: "active", reason: "训练问题定义" }, progress: { completedDays: 0, scoredCount: 0 } })
    .mockResolvedValueOnce({ plan: { focusDimension: "问题定义", status: "completed", reason: "已归档" }, progress: null });
  const first = render(<HomePlanCard />);
  expect(await screen.findByText(/问题定义.*进行中/)).toBeTruthy();
  expect(screen.getByText(/完成 0 天.*评分 0 题/)).toBeTruthy();
  first.unmount();
  render(<HomePlanCard />);
  expect(await screen.findByText(/问题定义.*已归档/)).toBeTruthy();
});

it("没有本人包时引导去画像；读取故障可重试，不展示猜测进度", async () => {
  mocks.active.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("故障"))
    .mockResolvedValueOnce({ id: "active", dimension: "用户理解", status: "active", items: [{ state: "inconsistent" }] });
  mocks.hub.mockResolvedValue({ history: [] });
  const first = render(<HomePackCard />);
  expect(await screen.findByText(/暂无训练包/)).toBeTruthy();
  expect(screen.getByRole("link", { name: /查看能力画像/ }).getAttribute("href")).toBe("/profile");
  first.unmount();
  render(<HomePackCard />);
  expect(await screen.findByText(/训练包状态暂不可用/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText(/状态待恢复/)).toBeTruthy();
  await waitFor(() => expect(mocks.active).toHaveBeenCalledTimes(3));
});

it("已放弃的最近训练包仅提供回看入口", async () => {
  mocks.active.mockResolvedValue({ id: "old", dimension: "问题定义", status: "abandoned", items: [] });
  render(<HomePackCard />);
  expect(await screen.findByText(/训练包已放弃/)).toBeTruthy();
  expect(screen.getByRole("link", { name: /查看训练包/ }).getAttribute("href")).toBe("/training/pack/old");
});
