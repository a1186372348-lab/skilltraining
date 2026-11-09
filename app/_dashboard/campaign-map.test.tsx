// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CampaignMap } from "./campaign-map";

const mocks = vi.hoisted(() => ({ stage: vi.fn() }));
vi.mock("@/app/_shared/stage-badge/stage-provider", () => ({ useStageOverview: mocks.stage }));
vi.mock("./home-plan-card", () => ({ HomePlanCard: () => <div>真实周计划</div> }));
vi.mock("./home-pack-card", () => ({ HomePackCard: () => <div>真实训练包</div> }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const overview = { stage: "exploration", baselineCompleted: true, dimensions: [
  { dimension: "用户理解", observed: true, status: "pending", consecutive: 3, triggerId: "a", activeSessionId: null, activeSessionStatus: null, reason: null },
  { dimension: "问题定义", observed: false, status: "unverified", consecutive: null, triggerId: null, activeSessionId: null, activeSessionStatus: null, reason: null },
], timeline: [] };

it("地图呈现四个实际节点；探索期间已触发的复测仍可进入", () => {
  mocks.stage.mockReturnValue({ overview, loading: false, error: null, refresh: vi.fn() });
  render(<CampaignMap />);
  expect(screen.getByRole("heading", { name: "你的成长战役地图" })).toBeTruthy();
  expect(screen.getByText("起点 · 基线测评")).toBeTruthy();
  expect(screen.getByText("探索期")).toBeTruthy();
  expect(screen.getByText("强化期")).toBeTruthy();
  expect(screen.getByText("复测期")).toBeTruthy();
  expect(screen.getByText(/用户理解.*待复测/)).toBeTruthy();
  expect(screen.getByRole("link", { name: /查看复测/ }).getAttribute("href")).toBe("/stages");
  expect(screen.getByText("真实周计划")).toBeTruthy();
  expect(screen.getByText("真实训练包")).toBeTruthy();
});

it("仅有挂起或待恢复复测时不暗示已有可用题，并分别说明状态", () => {
  const dimensions = [
    { ...overview.dimensions[0], dimension: "用户理解", status: "suspended", reason: "no_candidate" },
    { ...overview.dimensions[0], dimension: "问题定义", status: "needs_recovery", reason: "session_missing" },
  ];
  mocks.stage.mockReturnValue({ overview: { ...overview, dimensions }, loading: false, error: null, refresh: vi.fn() });
  render(<CampaignMap />);
  const node = screen.getByText("复测期").closest("li")!;
  expect(within(node).getByText("待复测")).toBeTruthy();
  expect(within(node).queryByText("可复测")).toBeNull();
  expect(screen.getByText(/用户理解（复测挂起）/)).toBeTruthy();
  expect(screen.getByText(/问题定义（状态待恢复）/)).toBeTruthy();
});

it("未完成基线先显示起点，当前阶段恢复强化时不把复测当永久通关", () => {
  mocks.stage.mockReturnValue({ overview: { ...overview, baselineCompleted: false }, loading: false, error: null, refresh: vi.fn() });
  const first = render(<CampaignMap />);
  expect(screen.getByRole("link", { name: "完成基线测评" }).getAttribute("href")).toBe("/baseline");
  expect(within(screen.getByText("起点 · 基线测评").closest("li")!).getByText("当前")).toBeTruthy();
  first.unmount();
  mocks.stage.mockReturnValue({ overview: { ...overview, stage: "strengthening", dimensions: [] }, loading: false, error: null, refresh: vi.fn() });
  render(<CampaignMap />);
  expect(within(screen.getByText("强化期").closest("li")!).getByText("当前")).toBeTruthy();
  expect(within(screen.getByText("复测期").closest("li")!).getByText(/连续 3 次/)).toBeTruthy();
});

it("阶段读取失败给出重试，不影响计划与训练包入口", () => {
  const refresh = vi.fn();
  mocks.stage.mockReturnValue({ overview: null, loading: false, error: "阶段暂不可用", refresh });
  render(<CampaignMap />);
  expect(screen.getByText("阶段暂不可用")).toBeTruthy();
  expect(screen.getByText("真实周计划")).toBeTruthy();
  expect(screen.getByText("真实训练包")).toBeTruthy();
});
