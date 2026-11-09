// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HomeShell } from "@/app/_dashboard/home-shell";
import { TrainingShell } from "@/app/training/shell";
import { TodayShell } from "@/app/training/session/shell";
import { HistoryShell } from "@/app/training/history/shell";
import { ProfileShell } from "@/app/profile/shell";
import { SettingsShell } from "@/app/settings/shell";

vi.mock("./stage-provider", () => ({ StageProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("./stage-badge", () => ({ StageBadge: ({ compact }: { compact?: boolean }) => <span>{compact ? "窄屏阶段标识" : "侧栏阶段标识"}</span> }));
afterEach(cleanup);

it.each([
  ["首页", <HomeShell key="home" stageText="待开始" streakDays={0}>内容</HomeShell>],
  ["大厅", <TrainingShell key="training" stageText="待开始" streakDays={0}>内容</TrainingShell>],
  ["训练、基线、反馈和包详情", <TodayShell key="today" stageText="作答中">内容</TodayShell>],
  ["历史回放", <HistoryShell key="history" countText="暂无">内容</HistoryShell>],
  ["画像", <ProfileShell key="profile" progressText="0/8">内容</ProfileShell>],
  ["我的", <SettingsShell key="settings" accountText="已登录">内容</SettingsShell>],
])("%s 外壳挂载同一阶段事实的桌面和窄屏入口", (_name, shell) => {
  render(shell);
  expect(screen.getByText("侧栏阶段标识")).toBeTruthy();
  expect(screen.getByText("窄屏阶段标识")).toBeTruthy();
  expect(screen.getByText("内容")).toBeTruthy();
});

it("阶段页复用训练外壳时高亮成长阶段而非产品训练", () => {
  render(<TodayShell stageText="成长" activeLabel="成长阶段">内容</TodayShell>);
  expect(screen.getByText("成长阶段").closest("a")).toBeNull();
  expect(screen.getByRole("link", { name: "产品训练" }).getAttribute("href")).toBe("/training");
});

it("工作台可按需锁定大屏视口并保留阶段标识", () => {
  render(<TodayShell stageText="作答" lockViewport>工作台</TodayShell>);
  expect(screen.getByText("工作台")).toBeTruthy();
  expect(screen.getByText("侧栏阶段标识")).toBeTruthy();
  expect(screen.getByText("窄屏阶段标识")).toBeTruthy();
});
