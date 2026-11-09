// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProfileFlow } from "./profile-flow";

const mocks = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => { const router = { replace: mocks.replace }; return { useRouter: () => router }; });
vi.mock("./shell", () => ({ ProfileShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("画像揭晓门禁", () => {
  it("基线未完成时跳转基线，不显示已有评分", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ success: false, error: { code: "BASELINE_REQUIRED", message: "请先完成基线测评" } }) }));
    render(<ProfileFlow />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/baseline"));
    expect(screen.queryByText("73")).toBeNull();
  });

  it("其他错误保留重试入口，不误跳转基线", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: { code: "OTHER", message: "暂时无法加载" } }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { insight: { observedCount: 0, totalCount: 1, nextFocus: { dimension: "问题定义", mode: "explore", text: "先探索" } }, dimensions: [unknown], hintDependencyOverall: null } }) }));
    render(<ProfileFlow />);
    expect(await screen.findByText("暂时无法加载")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("开始第一次训练后，生成你的能力画像")).toBeTruthy();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});

const observed = { dimension: "用户理解", observed: true, currentScore: 63, observationCount: 3, hintDependency: 2, hintDependencyBand: "中", trend: "上升", statusLabel: "↑ 上升中", sparkline: [60, 63], recentScores: [60, 63], recentEvaluations: [], updatedAt: null };
const unknown = { dimension: "问题定义", observed: false, currentScore: null, observationCount: 0, hintDependency: null, hintDependencyBand: null, trend: null, statusLabel: null, sparkline: [], recentScores: [], recentEvaluations: [], updatedAt: null };

it("画像允许揭晓时可查看行内维度、建议与评估详情", async () => {
  const data = { insight: { observedCount: 1, totalCount: 2, nextFocus: { dimension: "用户理解", mode: "strengthen", text: "建议重点练用户理解" } }, dimensions: [observed, unknown], hintDependencyOverall: { average: 2, band: "中" } };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data }) }));
  render(<ProfileFlow />);
  expect(await screen.findByRole("button", { name: "查看评估记录" })).toBeTruthy();
  expect(document.body.textContent).toContain("建议重点练用户理解");
  fireEvent.click(screen.getByRole("button", { name: "查看评估记录" }));
  expect(screen.getByRole("dialog", { name: "用户理解 评估详情" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(screen.getByText("建议重点练")).toBeTruthy();
  expect(screen.getByText("问题定义")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /用户理解/ }));
  expect(screen.queryByText("建议重点练")).toBeNull();
});

it("全未知画像列表保留开始训练的引导", async () => {
  const data = { insight: { observedCount: 0, totalCount: 1, nextFocus: { dimension: "问题定义", mode: "explore", text: "建议先探索问题定义" } }, dimensions: [unknown], hintDependencyOverall: null };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data }) }));
  render(<ProfileFlow />);
  await screen.findByText("开始第一次训练后，生成你的能力画像");
  expect(document.body.textContent).toContain("建议先探索问题定义");
  expect(screen.getByText("问题定义")).toBeTruthy();
});
