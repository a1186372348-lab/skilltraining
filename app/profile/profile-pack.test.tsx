// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ProfileFlow } from "./profile-flow";

const mocks = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => { const router = { push: mocks.push, replace: mocks.replace }; return { useRouter: () => router }; });
vi.mock("./shell", () => ({ ProfileShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const names = ["问题定义", "用户理解", "根因分析", "产品价值判断", "方案设计", "产品取舍", "指标与验证", "产品表达"];
const available = { status: "available", activePackId: null, completedCount: null, availableQuestions: 6, requiredQuestions: 5 };
const evaluations = [
  { sessionId: "one", score: 73, scoredAt: "2026-01-03T00:00:00.000Z", caseTitle: "最新无信心", confidence: null },
  { sessionId: "two", score: 64, scoredAt: "2026-01-02T00:00:00.000Z", caseTitle: "零信心", confidence: 0 },
  { sessionId: "three", score: 61, scoredAt: "2026-01-01T00:00:00.000Z", caseTitle: "较早有信心", confidence: 78 },
];

function makeView(ctas: Record<string, object> = {}) {
  return {
    insight: { observedCount: 7, totalCount: 8, nextFocus: { dimension: "产品表达", mode: "explore", text: "建议先探索产品表达" } },
    dimensions: names.map((dimension, i) => ({
      dimension, observed: i !== 7, currentScore: i === 7 ? null : 60 + i, observationCount: i === 7 ? 0 : 3,
      hintDependency: i === 7 ? null : 1, hintDependencyBand: i === 7 ? null : "低", trend: i === 7 ? null : "稳定",
      statusLabel: i === 7 ? null : "稳定", sparkline: i === 7 ? [] : [60, 61], recentScores: i === 7 ? [] : [60, 61],
      recentEvaluations: i === 0 ? evaluations : [], updatedAt: null, packCta: ctas[dimension] ?? available,
    })),
    hintDependencyOverall: { average: 1, band: "低" },
  };
}

function mockRequests(view: ReturnType<typeof makeView>, createResponse: object = { pack: { id: "new-pack" } }) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/profile/ability") return { ok: true, json: async () => ({ success: true, data: view }) };
    if (url === "/api/packs" && init?.method === "POST") return { ok: true, json: async () => ({ success: true, data: createResponse }) };
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function row(name: string) {
  return screen.getByText(name, { selector: "li *" }).closest("li")!;
}

it("八维唯一行内画像保留未知态、建议与逐次信心，并可发起包", async () => {
  const fetcher = mockRequests(makeView());
  render(<ProfileFlow />);
  await screen.findByText(/建议先探索产品表达/);
  expect(screen.queryByRole("button", { name: "网络图" })).toBeNull();
  expect(screen.queryByRole("button", { name: "列表" })).toBeNull();
  for (const name of names) expect(row(name)).toBeTruthy();
  expect(within(row("产品表达")).getByText("未观测")).toBeTruthy();
  fireEvent.click(within(row("问题定义")).getByRole("button", { name: "查看评估记录" }));
  const dialog = screen.getByRole("dialog", { name: "问题定义 评估详情" });
  expect(within(dialog).getByText("本次评分信心：0/100（AI 自评）")).toBeTruthy();
  expect(within(dialog).getByText("本次评分信心：78/100（AI 自评）")).toBeTruthy();
  expect(within(dialog).queryAllByText(/本次评分信心/)).toHaveLength(2);
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  fireEvent.click(within(row("问题定义")).getByRole("button", { name: "发起攻坚包" }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/training/pack/new-pack"));
  expect(fetcher).toHaveBeenCalledWith("/api/packs", expect.objectContaining({ method: "POST", body: JSON.stringify({ dimension: "问题定义" }) }));
});

it("同维已有包时继续而不重建，其他维禁用并说明原因", async () => {
  const active = { status: "active-self", activePackId: "existing-pack", completedCount: 2, availableQuestions: 0, requiredQuestions: 5 };
  const other = { status: "disabled-other-active", activePackId: null, completedCount: null, availableQuestions: 6, requiredQuestions: 5 };
  const fetcher = mockRequests(makeView(Object.fromEntries(names.map(name => [name, name === "问题定义" ? active : other]))));
  render(<ProfileFlow />);
  const link = await screen.findByRole("link", { name: "继续攻坚包 · 2/5" });
  expect(link.getAttribute("href")).toBe("/training/pack/existing-pack");
  const disabled = within(row("用户理解")).getByRole("button", { name: "发起攻坚包" });
  expect(disabled.hasAttribute("disabled")).toBe(true);
  expect(within(row("用户理解")).getByText(/一次只能进行一个训练包/)).toBeTruthy();
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/packs")).toHaveLength(0);
});

it("可用题不足或基线未完成时禁用并解释原因", async () => {
  const unavailable = { status: "disabled-insufficient", activePackId: null, completedCount: null, availableQuestions: 3, requiredQuestions: 5 };
  const baseline = { status: "baseline-required", activePackId: null, completedCount: null, availableQuestions: 0, requiredQuestions: 5 };
  mockRequests(makeView({ 问题定义: unavailable, 用户理解: baseline }));
  render(<ProfileFlow />);
  await screen.findByText(/建议先探索产品表达/);
  expect(within(row("问题定义")).getByText(/可用未练题 3\/5/)).toBeTruthy();
  expect(within(row("用户理解")).getByText(/先完成基线测评/)).toBeTruthy();
  expect(within(row("问题定义")).getByRole("button", { name: "发起攻坚包" }).hasAttribute("disabled")).toBe(true);
  expect(within(row("用户理解")).getByRole("button", { name: "发起攻坚包" }).hasAttribute("disabled")).toBe(true);
});

it("发起失败保留画像并显示服务端安全原因；缺失入口状态不允许发起", async () => {
  const view = makeView();
  delete (view.dimensions[1] as { packCta?: object }).packCta;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/profile/ability"
    ? { ok: true, json: async () => ({ success: true, data: view }) }
    : { ok: false, json: async () => ({ success: false, error: { code: "ACTIVE_PACK_EXISTS", message: "请先完成当前包" } }) }));
  render(<ProfileFlow />);
  await screen.findByText(/建议先探索产品表达/);
  expect(within(row("用户理解")).getByText(/训练包状态暂不可用/)).toBeTruthy();
  fireEvent.click(within(row("问题定义")).getByRole("button", { name: "发起攻坚包" }));
  expect((await screen.findByRole("alert")).textContent).toContain("请先完成当前包");
  expect(mocks.push).not.toHaveBeenCalled();
});
