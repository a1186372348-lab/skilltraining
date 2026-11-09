import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ overview: vi.fn(), start: vi.fn() }));
vi.mock("@/server/modules/stages", () => ({
  getStageOverviewInTransaction: mocks.overview,
  startRetestInTransaction: mocks.start,
  StageError: class StageError extends Error {
    constructor(readonly code: string, readonly httpStatus: number, message: string) { super(message); }
  },
}));

import { StageError } from "@/server/modules/stages";
import { pickRetestInTransaction } from "./retest-entry";

const owner = "owner";
const ready = { state: "ready", sessionId: "s", triggerId: "trigger", dimension: "问题定义", sessionState: "followup" };
const session = { id: "s", question: { id: "q" } };
const findSession = vi.fn(async () => session);
const context = { userId: owner, tx: { trainingSession: { findFirst: findSession } } } as never;

beforeEach(() => { mocks.overview.mockReset(); mocks.start.mockReset(); findSession.mockReset().mockResolvedValue(session); });

describe("用户事务内复测推荐", () => {
  it("未完成基线的旧用户只跳过阶段推荐", async () => {
    mocks.overview.mockResolvedValue({ baselineCompleted: false, dimensions: [] });
    expect(await pickRetestInTransaction(context)).toBeNull();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("跳过明确待恢复的维度，继续已有复测并保留真实来源", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.overview.mockResolvedValue({ baselineCompleted: true, dimensions: [
        { status: "needs_recovery", triggerId: "damaged" },
        { status: "pending", triggerId: "trigger" },
      ] });
      mocks.start.mockResolvedValue(ready);
      expect(await pickRetestInTransaction(context)).toEqual({ question: session.question, sessionId: "s", triggerId: "trigger", dimension: "问题定义" });
      expect(mocks.start).toHaveBeenCalledOnce();
      expect(JSON.stringify(warning.mock.calls)).not.toContain("damaged");
    } finally { warning.mockRestore(); }
  });

  it("无题、已结算及明确待恢复均不伪装为复测会话", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.overview.mockResolvedValue({ baselineCompleted: true, dimensions: [
        { status: "suspended", triggerId: "a" }, { status: "pending", triggerId: "b" }, { status: "pending", triggerId: "c" },
      ] });
      mocks.start.mockResolvedValueOnce({ state: "settled" }).mockResolvedValueOnce({ state: "needs_recovery" });
      expect(await pickRetestInTransaction(context)).toBeNull();
      expect(warning).toHaveBeenCalledOnce();
    } finally { warning.mockRestore(); }
  });

  it("基线门禁与真实数据库错误继续报错，不降级为无题", async () => {
    mocks.overview.mockRejectedValueOnce(new StageError("BASELINE_REQUIRED", 409, "请先完成基线"));
    await expect(pickRetestInTransaction(context)).rejects.toMatchObject({ code: "BASELINE_REQUIRED", httpStatus: 409 });
    mocks.overview.mockRejectedValueOnce(new Error("storage failure"));
    await expect(pickRetestInTransaction(context)).rejects.toThrow("storage failure");
  });

  it("阶段服务返回 ready 但本人会话不存在时明确报错", async () => {
    mocks.overview.mockResolvedValue({ baselineCompleted: true, dimensions: [{ status: "pending", triggerId: "trigger" }] });
    mocks.start.mockResolvedValue(ready);
    findSession.mockResolvedValueOnce(null as never);
    await expect(pickRetestInTransaction(context)).rejects.toMatchObject({ code: "RETEST_NEEDS_RECOVERY" });
  });
});
