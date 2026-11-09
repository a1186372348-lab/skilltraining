// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TrainingHubFlow } from "./hub-flow";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), active: vi.fn().mockResolvedValue(null) }));
vi.mock("./api", () => ({ fetchTrainingHub: mocks.fetch }));
vi.mock("./pack/api", () => ({ fetchActivePack: mocks.active }));
vi.mock("./shell", () => ({ TrainingShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("./current-training-card", () => ({ CurrentTrainingCard: ({ onChanged }: { onChanged: () => void }) => <button onClick={onChanged}>更新当前卡</button> }));
vi.mock("./daily-action", () => ({ DailyTrainingAction: () => <button>先做日常训练</button> }));
vi.mock("../_shared/plan-cards", () => ({ PlanSection: () => null }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const historyItem = (sessionId: string, caseTitle: string) => ({ sessionId, caseTitle, isExtra: false, isBaseline: false, state: "scored", hasFinalAnswer: true, abilityTags: [], scores: [], startedAt: "2026-10-01T08:00:00Z" });
const hub = (history: unknown[]) => ({ current: { kind: "not_started", dateKey: "2026-11-03" }, history, streakDays: 0 });

it("三种历史徽章正确显示，基线回放准确指向被点击会话", async () => {
  mocks.fetch.mockResolvedValueOnce(hub([
    { ...historyItem("b", "基线案例"), isExtra: true, isBaseline: true, state: "followup", scores: [{ dimension: "用户理解", effectiveScore: 70 }, { dimension: "问题定义", effectiveScore: 60 }], abilityTags: ["用户理解"] },
    { ...historyItem("e", "加练案例"), isExtra: true },
    historyItem("d", "每日案例"),
  ])).mockResolvedValue(hub([]));
  render(<TrainingHubFlow />);
  const baseline = (await screen.findByText("基线案例")).closest("a")!;
  expect(screen.getByRole("button", { name: "先做日常训练" })).toBeTruthy();
  expect(baseline.getAttribute("href")).toBe("/training/history/b");
  expect(within(baseline).getByText("基线")).toBeTruthy();
  expect(within(baseline).queryByText("加练")).toBeNull();
  expect(within(screen.getByText("加练案例").closest("a")!).getByText("加练")).toBeTruthy();
  expect(within(screen.getByText("每日案例").closest("a")!).getByText("每日")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "更新当前卡" }));
  expect(await screen.findByText(/还没有训练记录/)).toBeTruthy();
});

it("复测历史显示来源并保留阶段恢复入口，不误标加练", async () => {
  mocks.fetch.mockResolvedValue(hub([{ ...historyItem("r", "复测案例"), isExtra: true, sourceType: "retest", sourceId: "11111111-1111-4111-8111-111111111111", state: "answering" }]));
  render(<TrainingHubFlow />);
  const row = (await screen.findByText("复测案例")).closest("a")!;
  expect(row.getAttribute("href")).toBe("/training/session/r");
  expect(within(row).getByText("复测")).toBeTruthy();
  expect(within(row).queryByText("加练")).toBeNull();
  expect(screen.getByRole("link", { name: "查看复测进度" }).getAttribute("href")).toBe("/stages");
});

it("加载失败提供重试，重试后显示记录", async () => {
  mocks.fetch.mockRejectedValueOnce(new Error("暂时无法加载")).mockResolvedValueOnce(hub([historyItem("d", "重试案例")]));
  render(<TrainingHubFlow />);
  expect(await screen.findByText("暂时无法加载")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await waitFor(() => expect(screen.getByText("重试案例")).toBeTruthy());
});

it("大厅显示进行中包进度和评分中状态，历史优先识别包来源", async () => {
  mocks.fetch.mockResolvedValue(hub([
    { ...historyItem("p", "专项案例"), isExtra: true, sourceType: "pack", sourceId: "11111111-1111-4111-8111-111111111111" },
    { ...historyItem("broken", "待恢复案例"), isExtra: true, sourceType: "pack", sourceId: "broken" },
  ]));
  mocks.active.mockResolvedValueOnce({ id: "pack-1", dimension: "问题定义", status: "active", items: [{ state: "scored" }, { state: "awaiting_score" }] });
  render(<TrainingHubFlow />);
  const link = await screen.findByRole("link", { name: /继续攻坚/ });
  expect(link.getAttribute("href")).toBe("/training/pack/pack-1");
  expect(screen.getByText(/已完成 1\/5/)).toBeTruthy();
  expect(screen.getByText(/评分中/)).toBeTruthy();
  const history = screen.getByText("专项案例").closest("a")!;
  expect(within(history).getByText("训练包")).toBeTruthy();
  expect(within(history).queryByText("加练")).toBeNull();
  expect(history.getAttribute("href")).toBe("/training/history/p");
  expect(screen.getByRole("link", { name: "查看训练包" }).getAttribute("href")).toBe("/training/pack/11111111-1111-4111-8111-111111111111");
  expect(screen.getByText("训练包信息待恢复")).toBeTruthy();
});
