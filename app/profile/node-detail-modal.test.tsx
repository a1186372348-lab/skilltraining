// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { AbilityDimensionView } from "./contract";
import { NodeDetailModal } from "./node-detail-modal";

afterEach(cleanup);

it("每条最近评估展示自己的 AI 自评信心，0 可见、NULL 不显示", () => {
  const dim: AbilityDimensionView = {
    dimension: "用户理解", observed: true, currentScore: 70, observationCount: 3,
    hintDependency: 0, hintDependencyBand: "低", trend: "稳定", statusLabel: "稳定",
    sparkline: [], recentScores: [], updatedAt: null,
    recentEvaluations: [
      { sessionId: "latest", score: 80, scoredAt: "2026-10-03", caseTitle: "最新案例", confidence: null },
      { sessionId: "older", score: 70, scoredAt: "2026-10-02", caseTitle: "旧案例", confidence: 78 },
      { sessionId: "zero", score: 60, scoredAt: "2026-10-01", caseTitle: "零值案例", confidence: 0 },
    ],
  };
  render(<NodeDetailModal dim={dim} nextFocus={{ dimension: "用户理解", mode: "strengthen", text: "建议" }} onClose={() => {}} />);
  const rowFor = (title: string) => screen.getByText(title).closest("li")!;
  expect(within(rowFor("最新案例")).queryByText(/评分信心/)).toBeNull();
  expect(within(rowFor("旧案例")).getByText("本次评分信心：78/100（AI 自评）")).toBeTruthy();
  expect(within(rowFor("零值案例")).getByText("本次评分信心：0/100（AI 自评）")).toBeTruthy();
  expect(screen.queryByText(/准确率/)).toBeNull();
});

it("未观测维度保持未知，并可关闭详情", () => {
  const dim: AbilityDimensionView = {
    dimension: "问题定义", observed: false, currentScore: null, observationCount: 0,
    hintDependency: null, hintDependencyBand: null, trend: null, statusLabel: null,
    sparkline: [], recentScores: [], recentEvaluations: [], updatedAt: null,
  };
  const close = vi.fn();
  render(<NodeDetailModal dim={dim} nextFocus={{ dimension: "用户理解", mode: "explore", text: "建议" }} onClose={close} />);
  expect(screen.getByText("未观测")).toBeTruthy();
  expect(screen.getByText(/该维度尚未观测/)).toBeTruthy();
  expect(screen.queryByText("建议重点练")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(close).toHaveBeenCalled();
});
