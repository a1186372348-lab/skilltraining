// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TrainingFlow } from "./training-flow";
import { ApiError } from "./api";

const mocks = vi.hoisted(() => ({ get: vi.fn(), replace: vi.fn(), push: vi.fn(), hint: vi.fn(), first: vi.fn(), final: vi.fn(), followupHint: vi.fn(), retry: vi.fn(), extra: vi.fn() }));
vi.mock("next/navigation", () => { const router = { replace: mocks.replace, push: mocks.push }; return { useRouter: () => router }; });
vi.mock("./api", () => ({ fetchSessionById: mocks.get, fetchTodaySession: mocks.get, requestHint: mocks.hint, submitFirstAnswer: mocks.first, submitFinalAnswer: mocks.final, requestFollowupHint: mocks.followupHint, retryFollowups: mocks.retry, startExtraSession: mocks.extra, ApiError: class extends Error { constructor(public code: string, message: string) { super(message); } } }));
vi.mock("./shell", () => ({ TodayShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("./pack-context", () => ({ PackContext: ({ canAbandon }: { canAbandon: boolean }) => <p>{canAbandon ? "包题可确认终止" : "包题不可终止"}</p> }));
vi.mock("./retest-context", () => ({ RetestContext: ({ canAbandon }: { canAbandon: boolean }) => <p>{canAbandon ? "复测可确认终止" : "复测不可终止"}</p> }));
beforeEach(() => vi.resetAllMocks());
afterEach(() => { cleanup(); vi.useRealTimers(); });

function session(overrides: Record<string, unknown> = {}) {
  return { sessionId: "s", sourceType: "pack", sourceId: "p", state: "reading", hintCount: 0, followupHintCount: 0,
    coefficient: 1, canRequestHint: true, releasedHints: [], firstAnswer: null, finalAnswer: null,
    firstSubmittedAt: null, finalSubmittedAt: null, followups: [], caseTitle: "案例", caseBackground: {},
    caseSources: [], mainQuestion: "问题？", abilityTags: ["问题定义"], materials: { core: [{ title: "资料", source: "测试", url: "https://example.com", summary: "合成摘要" }], extended: [] }, ...overrides };
}

it("未提交包题在工作台显示来源及确认入口", async () => {
  mocks.get.mockResolvedValue(session());
  render(<TrainingFlow sessionId="s" />);
  expect(await screen.findByText("包题可确认终止")).toBeTruthy();
});

it("复测根据真实终答状态显示可终止或评分中，来源缺失时不猜会话", async () => {
  mocks.get.mockResolvedValue(session({ sourceType: "retest", sourceId: "trigger" }));
  const first = render(<TrainingFlow sessionId="s" />);
  expect(await screen.findByText("复测可确认终止")).toBeTruthy();
  first.unmount();
  mocks.get.mockResolvedValue(session({ sourceType: "retest", sourceId: "trigger", state: "followup", finalAnswer: "已答", finalSubmittedAt: "2026-11-03T00:00:00Z" }));
  render(<TrainingFlow sessionId="s" />);
  expect(await screen.findByText("复测不可终止")).toBeTruthy();
});

it("复测终答提交期间立即禁用终止；来源标识缺失显示待恢复", async () => {
  let finish: ((value: object) => void) | undefined;
  mocks.get.mockResolvedValue(session({ sourceType: "retest", sourceId: "trigger", state: "followup", firstAnswer: "初答", followupGateSkipped: true }));
  mocks.final.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const first = render(<TrainingFlow sessionId="s" />);
  expect(await screen.findByText("复测可确认终止")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "最终回答" } });
  fireEvent.click(screen.getByRole("button", { name: "提交最终答案" }));
  expect(screen.getByText("复测不可终止")).toBeTruthy();
  await act(async () => finish?.({ state: "followup", finalAnswer: "最终回答" }));
  first.unmount();
  mocks.get.mockResolvedValue(session({ sourceType: "retest", sourceId: null }));
  render(<TrainingFlow sessionId="s" />);
  expect(await screen.findByText("复测验证 · 状态待恢复")).toBeTruthy();
  expect(screen.queryByText("复测可确认终止")).toBeNull();
});

it("已交终答或完成的包题不提供终止入口", async () => {
  mocks.get.mockResolvedValue(session({ state: "followup", finalSubmittedAt: "2026-01-01T00:00:00Z", finalAnswer: "已提交" }));
  render(<TrainingFlow sessionId="s" />);
  expect(await screen.findByText("包题不可终止")).toBeTruthy();
});

it("包来源缺少 ID 时显示待恢复，不显示终止入口", async () => {
  mocks.get.mockResolvedValue(session({ sourceId: null }));
  render(<TrainingFlow sessionId="s" />);
  expect(await screen.findByText("专项训练包 · 状态待恢复")).toBeTruthy();
  expect(screen.queryByText("包题可确认终止")).toBeNull();
});

it("包题可请求提示并提交首答，闸门跳过时进入最终回答", async () => {
  mocks.get.mockResolvedValue(session());
  mocks.hint.mockResolvedValue({ state: "answering", hintCount: 1, coefficient: 0.9, hint: { level: 1, stage: "澄清", question: "谁遇到问题？" } });
  mocks.first.mockResolvedValue({ state: "followup", firstAnswer: "先明确用户", followups: [], followupGateSkipped: true, coefficient: 0.9 });
  render(<TrainingFlow sessionId="s" />);
  fireEvent.click(await screen.findByRole("button", { name: /给我一个提示/ }));
  expect(await screen.findByText("谁遇到问题？")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "先明确用户" } });
  fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
  expect(await screen.findByText("首答足够扎实 ✓")).toBeTruthy();
});

it("最终答案提交中立即隐藏包题终止，成功后返回包详情等待评分", async () => {
  let finish: ((value: object) => void) | undefined;
  mocks.get.mockResolvedValue(session({ state: "followup", firstAnswer: "初答", followupGateSkipped: true }));
  mocks.final.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<TrainingFlow sessionId="s" />);
  expect(await screen.findByText("包题可确认终止")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "最终回答" } });
  fireEvent.click(screen.getByRole("button", { name: "提交最终答案" }));
  expect(screen.getByText("包题不可终止")).toBeTruthy();
  await act(async () => finish?.({ state: "followup", finalAnswer: "最终回答" }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/training/pack/p"));
});

it("普通题终答成功后仍进入原反馈页；包 ID 缺失不猜详情地址", async () => {
  mocks.get.mockResolvedValue(session({ sourceType: "daily", sourceId: null, state: "followup", firstAnswer: "初答", followupGateSkipped: true }));
  mocks.final.mockResolvedValue({ state: "followup", finalAnswer: "最终回答" });
  const first = render(<TrainingFlow sessionId="s" />);
  await screen.findByText("首答足够扎实 ✓");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "最终回答" } });
  fireEvent.click(screen.getByRole("button", { name: "提交最终答案" }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/training/feedback/s"));
  first.unmount();
  mocks.push.mockClear();
  mocks.get.mockResolvedValue(session({ sourceType: "pack", sourceId: null, state: "followup", firstAnswer: "初答", followupGateSkipped: true }));
  render(<TrainingFlow sessionId="s" />);
  await screen.findByText("首答足够扎实 ✓");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "最终回答" } });
  fireEvent.click(screen.getByRole("button", { name: "提交最终答案" }));
  expect(await screen.findByText(/训练包信息缺失/)).toBeTruthy();
  expect(mocks.push).not.toHaveBeenCalled();
});

it("追问提示按需释放；追问失败可重试并选择跳过", async () => {
  mocks.get.mockResolvedValue(session({ state: "followup", firstAnswer: "初答", firstSubmittedAt: "2020-01-01T00:00:00Z", followups: [{ round: 1, question: "为何如此？", hasHint: true, hintReleased: false }] }));
  mocks.followupHint.mockResolvedValue({ hint: "考虑替代方案", followupHintCount: 1, coefficient: 0.95 });
  const first = render(<TrainingFlow sessionId="s" />);
  fireEvent.click(await screen.findByRole("button", { name: /给我一个提示/ }));
  expect(await screen.findByText("考虑替代方案")).toBeTruthy();
  first.unmount();
  mocks.get.mockResolvedValue(session({ state: "followup", firstAnswer: "初答", firstSubmittedAt: "2020-01-01T00:00:00Z", followups: [] }));
  mocks.retry.mockResolvedValue({ followups: [] });
  render(<TrainingFlow sessionId="s" />);
  fireEvent.click(await screen.findByRole("button", { name: "重试本次对话" }));
  expect(await screen.findByText("重试未成功，可再试一次或跳过追问。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "跳过追问，直接作答" }));
  expect(screen.getByRole("textbox")).toBeTruthy();
});

it("已完成训练可进入新加练；加载失败可重试", async () => {
  mocks.get.mockRejectedValueOnce(new Error("暂时无法加载")).mockResolvedValueOnce(session({ state: "scored", finalAnswer: "已完成" }));
  mocks.extra.mockResolvedValue({ sessionId: "extra" });
  render(<TrainingFlow sessionId="s" />);
  fireEvent.click(await screen.findByRole("button", { name: "重新加载" }));
  fireEvent.click(await screen.findByRole("button", { name: "再练一题" }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/training/session/extra"));
});

it("基线和已终止会话分别回到正确入口；无今日题显示空态", async () => {
  mocks.get.mockRejectedValueOnce(new ApiError("BASELINE_SESSION", "基线"));
  const first = render(<TrainingFlow sessionId="s" />);
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/baseline"));
  first.unmount();
  mocks.get.mockRejectedValueOnce(new ApiError("SESSION_ABANDONED", "已终止"));
  const second = render(<TrainingFlow sessionId="s" />);
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/training"));
  second.unmount();
  mocks.get.mockResolvedValueOnce(null);
  render(<TrainingFlow />);
  expect(await screen.findByText("今天暂时没有可训练的题目")).toBeTruthy();
});

it("提示或首答失败时保留作答并允许重试", async () => {
  mocks.get.mockResolvedValue(session());
  mocks.hint.mockRejectedValue(new Error("提示暂不可用"));
  mocks.first.mockRejectedValueOnce(new Error("提交暂不可用"));
  render(<TrainingFlow sessionId="s" />);
  fireEvent.click(await screen.findByRole("button", { name: /给我一个提示/ }));
  expect(await screen.findByText("提示暂不可用")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "保留这段回答" } });
  fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
  expect(await screen.findByText("提交暂不可用")).toBeTruthy();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("保留这段回答");
});

it("最终回答失败可重试，基线复用成功只触发完成回调", async () => {
  mocks.get.mockResolvedValue(session({ sourceType: "baseline", kind: "baseline", state: "followup", firstAnswer: "初答", followupGateSkipped: true }));
  mocks.final.mockRejectedValueOnce(new Error("提交失败"))
    .mockResolvedValueOnce({ state: "followup", finalAnswer: "最终回答" });
  const completed = vi.fn();
  render(<TrainingFlow withShell={false} redirectToFeedbackOnDone={false} onFinalSubmitted={completed} />);
  await screen.findByText("首答足够扎实 ✓");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "最终回答" } });
  fireEvent.click(screen.getByRole("button", { name: "提交最终答案" }));
  expect(await screen.findByText("提交失败")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "提交最终答案" }));
  await waitFor(() => expect(completed).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "再练一题" })).toBeNull();
});

it("追问提示失败可见，重试追问成功后恢复对话", async () => {
  mocks.get.mockResolvedValue(session({ state: "followup", firstAnswer: "初答", firstSubmittedAt: "2020-01-01T00:00:00Z", followups: [{ round: 1, question: "为什么？", hasHint: true }] }));
  mocks.followupHint.mockRejectedValue(new Error("追问提示暂不可用"));
  const first = render(<TrainingFlow sessionId="s" />);
  fireEvent.click(await screen.findByRole("button", { name: /给我一个提示/ }));
  expect(await screen.findByText("追问提示暂不可用")).toBeTruthy();
  first.unmount();
  mocks.get.mockResolvedValue(session({ state: "followup", firstAnswer: "初答", firstSubmittedAt: "2020-01-01T00:00:00Z", followups: [] }));
  mocks.retry.mockResolvedValue({ state: "followup", followups: [{ round: 1, question: "请解释取舍", hasHint: false }], coefficient: 1 });
  render(<TrainingFlow sessionId="s" />);
  fireEvent.click(await screen.findByRole("button", { name: "重试本次对话" }));
  expect(await screen.findByText("请解释取舍")).toBeTruthy();
});

it("失败追问重试后可切换为无需追问；加练门禁仍返回基线", async () => {
  mocks.get.mockResolvedValue(session({ state: "followup", firstAnswer: "初答", firstSubmittedAt: "2020-01-01T00:00:00Z", followups: [] }));
  mocks.retry.mockResolvedValue({ state: "followup", followups: [], followupGateSkipped: true, coefficient: 1 });
  const first = render(<TrainingFlow sessionId="s" />);
  fireEvent.click(await screen.findByRole("button", { name: "重试本次对话" }));
  expect(await screen.findByText("首答足够扎实 ✓")).toBeTruthy();
  first.unmount();
  mocks.get.mockResolvedValue(session({ state: "scored", finalAnswer: "已完成" }));
  mocks.extra.mockRejectedValue(new ApiError("BASELINE_REQUIRED", "先完成基线"));
  render(<TrainingFlow sessionId="s" />);
  fireEvent.click(await screen.findByRole("button", { name: "再练一题" }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/baseline"));
});

it("合成验收题在作答页隐藏标记并保留正文及原始数据", async () => {
  const marker = "【合成V2:123e4567-e89b-42d3-a456-426614174000:123e4567-e89b-42d3-a456-426614174001】";
  const value = session({ caseTitle: "合成验收案例 daily-15", mainQuestion: `${marker}如何验证方案？` });
  mocks.get.mockResolvedValue(value);
  render(<TrainingFlow sessionId="s" />);
  expect(await screen.findByText("合成日常案例 16")).toBeTruthy();
  expect(screen.getByText("如何验证方案？")).toBeTruthy();
  expect(screen.queryByText(/合成V2|daily-15/)).toBeNull();
  expect(value.mainQuestion).toBe(`${marker}如何验证方案？`);
  expect(value.caseTitle).toBe("合成验收案例 daily-15");
});
