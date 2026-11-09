import { afterEach, expect, it, vi } from "vitest";
import { abandonSession, fetchSessionById, fetchTodaySession, requestFollowupHint, requestHint, retryFollowups, startExtraSession, submitFinalAnswer, submitFirstAnswer } from "./api";

afterEach(() => vi.unstubAllGlobals());
it("保留默认自动推荐；显式普通训练把 daily 模式传给服务端", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: null }) });
  vi.stubGlobal("fetch", fetchMock);
  await fetchTodaySession();
  await fetchTodaySession("daily");
  expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/api/training/today", "/api/training/today?mode=daily"]);
});

it("读取本人会话时归一化旧追问，但绝不暴露未释放提示", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: {
    sessionId: "s", state: "reading", releasedHints: [], followups: ["旧追问", { round: 2, question: "新追问", hasHint: true, hintReleased: false, hint: "不可见" }, { question: "已释放", hintReleased: true, hint: "可见" }, null],
  } }) });
  vi.stubGlobal("fetch", fetchMock);
  const result = await fetchSessionById("s");
  expect(fetchMock.mock.calls[0][0]).toBe("/api/training/s");
  expect(result).toMatchObject({ hintCount: 0, canRequestHint: true, firstSubmittedAt: null, caseSources: [], followupGateSkipped: false });
  expect(result?.followups).toEqual([
    { round: 1, question: "旧追问", hasHint: false, hintReleased: false, hint: null },
    { round: 2, question: "新追问", hasHint: true, hintReleased: false, hint: null },
    { round: 3, question: "已释放", hasHint: true, hintReleased: true, hint: "可见" },
  ]);
});

it("首答、终答与追问请求保留真实路径和内容，缺失回显时保留用户原文", async () => {
  const values = [
    { state: "followup", followups: ["追问"], followupGateSkipped: true },
    { state: "followup" }, { state: "answering", hintCount: 1 },
    { round: 2, hint: "提示" }, { followups: [{ question: "新问题", round: 1 }] },
    { sessionId: "extra" }, { sessionId: "s", state: "abandoned" },
  ];
  const fetchMock = vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ success: true, data: values.shift() }) }));
  vi.stubGlobal("fetch", fetchMock);
  expect(await submitFirstAnswer("s", "首答")).toMatchObject({ firstAnswer: "首答", followupGateSkipped: true, followups: [{ question: "追问" }] });
  expect(await submitFinalAnswer("s", "终答")).toMatchObject({ finalAnswer: "终答" });
  await requestHint("s");
  await requestFollowupHint("s", 2);
  expect(await retryFollowups("s")).toMatchObject({ followups: [{ question: "新问题" }], followupGateSkipped: false });
  expect(await startExtraSession()).toMatchObject({ sessionId: "extra" });
  expect(await abandonSession("s")).toMatchObject({ state: "abandoned" });
  expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
    "/api/training/s/first-answer", "/api/training/s/final-answer", "/api/training/s/hint", "/api/training/s/followup-hint", "/api/training/s/followup-retry", "/api/training/extra", "/api/training/s/abandon",
  ]);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ answer: "首答" });
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ answer: "终答" });
  expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ round: 2 });
  expect(fetchMock.mock.calls[6][1].body).toBeUndefined();
});

it("服务端拒绝时保留错误码和安全文案，没有错误详情时使用通用提示", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: { code: "BASELINE_REQUIRED", message: "先完成基线" } }) })
    .mockResolvedValueOnce({ ok: false, json: async () => ({ success: false }) });
  vi.stubGlobal("fetch", fetchMock);
  await expect(fetchTodaySession("daily")).rejects.toMatchObject({ code: "BASELINE_REQUIRED", message: "先完成基线" });
  await expect(fetchSessionById("missing")).rejects.toMatchObject({ code: "UNKNOWN", message: "请求失败，请稍后重试" });
});
