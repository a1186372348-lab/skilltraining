// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaselineFlow } from "./baseline-flow";

const mocks = vi.hoisted(() => ({ status: vi.fn(), today: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => { const router = { push: mocks.push, replace: mocks.replace }; return { useRouter: () => router }; });
vi.mock("./api", () => ({ fetchBaselineStatus: mocks.status }));
vi.mock("../training/session/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../training/session/api")>(),
  fetchTodaySession: mocks.today,
}));
vi.mock("../training/session/shell", () => ({ TodayShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../training/session/training-flow", () => ({ TrainingFlow: ({ onFinalSubmitted }: { onFinalSubmitted: () => void }) => <button onClick={onFinalSubmitted}>提交答案</button> }));
const pending = { required: true, total: 8, answeredCount: 8, doneCount: 7, nextQuestion: null, completedAt: null };
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(4000); }); };
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each([
  ["空响应", () => new Response(null, { status: 500 })],
  ["非 JSON 响应", () => new Response("<html>Service unavailable</html>", { status: 502 })],
] as const)("基线加载遇到%s时显示中文提示及重试按钮", async (_description, response) => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
  mocks.status.mockImplementation(actual.fetchBaselineStatus);

  render(<BaselineFlow />);
  await act(async () => {});

  expect(screen.getByText("测评暂时无法加载，请重试")).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy();
  expect(mocks.replace).not.toHaveBeenCalled();
});

it("基线首次加载遇到没有正文的 401 时直接进入登录页", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
  mocks.status.mockImplementation(actual.fetchBaselineStatus);

  render(<BaselineFlow />);
  await act(async () => {});

  expect(mocks.replace).toHaveBeenCalledWith("/login");
  expect(screen.queryByRole("button", { name: "重新加载" })).toBeNull();
});
describe("基线收尾与续测", () => {
  it("收尾等待时晚到补测出现，恢复训练并可提交", async () => {
    mocks.status.mockResolvedValueOnce(pending).mockResolvedValueOnce({ ...pending, total: 9, nextQuestion: { id: "extra", caseTitle: "补测" } }).mockResolvedValue({ ...pending, total: 9, answeredCount: 9 });
    render(<BaselineFlow />); await act(async () => {});
    expect(screen.queryByText("提交答案")).toBeNull();
    await tick();
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    expect(screen.getByText(/已完成 9\/9 题/)).toBeTruthy();
  });
  it("无题继续等待，评分完成后跳转画像", async () => {
    mocks.status.mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValueOnce({ ...pending, required: false, doneCount: 8 });
    render(<BaselineFlow />); await act(async () => {});
    await tick();
    expect(mocks.push).not.toHaveBeenCalled();
    await tick();
    expect(mocks.push).toHaveBeenCalledWith("/profile");
  });
  it("断点恢复直接进入作答，加载失败提供重试入口", async () => {
    mocks.status.mockResolvedValueOnce({ ...pending, answeredCount: 2, nextQuestion: { id: "q", caseTitle: "题" } });
    mocks.today.mockResolvedValue({ kind: "baseline", firstAnswer: "已有答案" });
    render(<BaselineFlow />); await act(async () => {});
    expect(screen.getByRole("button", { name: "提交答案" })).toBeTruthy();
    cleanup();
    mocks.status.mockRejectedValueOnce(new Error("暂时无法加载"));
    render(<BaselineFlow />); await act(async () => {});
    expect(screen.getByText("暂时无法加载")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy();
  });
});



it("新用户从说明开始，提交后继续下一题并不展示单题评分", async () => {
  const first = { ...pending, answeredCount: 0, doneCount: 0, nextQuestion: { id: "first", caseTitle: "首题" } };
  mocks.status.mockResolvedValueOnce(first).mockResolvedValue({ ...first, answeredCount: 1, nextQuestion: { id: "second", caseTitle: "次题" } });
  mocks.today.mockResolvedValue({ kind: "baseline", firstAnswer: null });
  render(<BaselineFlow />); await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: /开始测评/ }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "提交答案" })); });
  expect(screen.getByText("本题已提交")).toBeTruthy();
  expect(screen.queryByText(/本题得分/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /进入下一题/ }));
  expect(screen.getByRole("button", { name: "提交答案" })).toBeTruthy();
});

it("收尾查询失败后自动重试并完成", async () => {
  mocks.status.mockResolvedValueOnce(pending).mockRejectedValueOnce(new Error("暂时失败")).mockResolvedValueOnce({ ...pending, required: false, doneCount: 8 });
  render(<BaselineFlow />); await act(async () => {});
  await tick(); expect(mocks.push).not.toHaveBeenCalled();
  await tick(); expect(mocks.push).toHaveBeenCalledWith("/profile");
});

it("通过基线接口恢复中断的加深题并显示续测提示", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  const next = { ...pending, total: 9, answeredCount: 8, nextQuestion: { id: "extra", caseTitle: "补测" }, items: [{ questionId: "extra", dimension: "问题定义", orderIndex: 8, state: "active", isDeepen: true }], resume: { hasInProgress: true, questionId: "extra", dimension: "问题定义", scoringPending: false } };
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: next }) }));
  vi.stubGlobal("fetch", fetchMock);
  mocks.status.mockImplementation(actual.fetchBaselineStatus);
  mocks.today.mockResolvedValue({ kind: "baseline", firstAnswer: "已有答案" });
  render(<BaselineFlow />); await act(async () => {});
  expect(fetchMock).toHaveBeenCalledWith("/api/training/baseline", expect.any(Object));
  expect(screen.getByText("加深题")).toBeTruthy();
  expect(screen.getByRole("button", { name: "提交答案" })).toBeTruthy();
  vi.unstubAllGlobals();
});

