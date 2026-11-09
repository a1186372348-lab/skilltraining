import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { submitFinalAnswer, submitFirstAnswer } from "./service";

type SimulatedSession = {
  id: string;
  userId: string;
  state: "reading" | "followup" | "abandoned";
  firstAnswer: string | null;
  firstSubmittedAt: Date | null;
  finalAnswer: string | null;
  finalSubmittedAt: Date | null;
  hintCount: number;
  followupHintCount: number;
  followups: null;
  question: { kind: "daily" };
};

function terminateBeforeUpdate(initial: SimulatedSession) {
  let row = { ...initial };
  const findUnique = vi.fn(async () => ({ ...row }));
  const updateMany = vi.fn(async ({ where, data }: {
    where: { state?: string | { in: string[] } };
    data: Partial<SimulatedSession>;
  }) => {
    row = { ...row, state: "abandoned" };
    const state = where.state;
    const allowed = state === undefined || (typeof state === "string" ? state === row.state : state.in.includes(row.state));
    if (!allowed) return { count: 0 };
    row = { ...row, ...data };
    return { count: 1 };
  });
  const db = { trainingSession: { findUnique, updateMany } } as unknown as PrismaClient;
  return { db, findUnique, updateMany, current: () => row };
}

function session(state: "reading" | "followup"): SimulatedSession {
  return {
    id: "session-1", userId: "user-1", state,
    firstAnswer: state === "followup" ? "首答" : null,
    firstSubmittedAt: state === "followup" ? new Date("2026-11-03T10:00:00Z") : null,
    finalAnswer: null, finalSubmittedAt: null, hintCount: 0, followupHintCount: 0,
    followups: null, question: { kind: "daily" },
  };
}

describe("终止与作答并发", () => {
  it("终止先提交时首答不能复活会话或伪造提交时间", async () => {
    const simulated = terminateBeforeUpdate(session("reading"));
    const generateFollowups = vi.fn();
    await expect(submitFirstAnswer(simulated.db, "session-1", "user-1", "新首答", { generateFollowups }))
      .rejects.toMatchObject({ code: "SESSION_ABANDONED" });
    expect(simulated.current()).toMatchObject({ state: "abandoned", firstAnswer: null, firstSubmittedAt: null });
    expect(generateFollowups).not.toHaveBeenCalled();
  });

  it("终止先提交时终答不能写入已终止会话", async () => {
    const simulated = terminateBeforeUpdate(session("followup"));
    await expect(submitFinalAnswer(simulated.db, "session-1", "user-1", "新终答"))
      .rejects.toMatchObject({ code: "SESSION_ABANDONED" });
    expect(simulated.current()).toMatchObject({ state: "abandoned", finalAnswer: null, finalSubmittedAt: null });
  });

  it("首答条件写入失败但没有真实提交记录时拒绝，而不构造时间", async () => {
    const initial = session("reading");
    const db = { trainingSession: { findUnique: vi.fn(async () => initial), updateMany: vi.fn(async () => ({ count: 0 })) } } as unknown as PrismaClient;
    await expect(submitFirstAnswer(db, "session-1", "user-1", "首答"))
      .rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("并发首答胜出时复用真实时间，不能再次生成追问", async () => {
    const initial = session("reading");
    const time = new Date("2026-11-03T10:15:00Z");
    const fresh = { ...session("followup"), firstSubmittedAt: time };
    const findUnique = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh);
    const db = { trainingSession: { findUnique, updateMany: vi.fn(async () => ({ count: 0 })) } } as unknown as PrismaClient;
    const generateFollowups = vi.fn();
    const result = await submitFirstAnswer(db, "session-1", "user-1", "首答", { generateFollowups });
    expect(result.firstSubmittedAt).toEqual(time);
    expect(generateFollowups).not.toHaveBeenCalled();
  });

  it("并发终答胜出时复用真实时间，未提交时按真实状态报错", async () => {
    const initial = session("followup");
    const time = new Date("2026-11-03T10:15:00Z");
    for (const [fresh, expected] of [
      [{ ...initial, finalSubmittedAt: time }, "submitted"],
      [{ ...initial, firstSubmittedAt: null }, "FIRST_ANSWER_REQUIRED"],
      [initial, "INVALID_STATE"],
    ] as const) {
      const findUnique = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh);
      const db = { trainingSession: { findUnique, updateMany: vi.fn(async () => ({ count: 0 })) } } as unknown as PrismaClient;
      const result = submitFinalAnswer(db, "session-1", "user-1", "终答");
      if (expected === "submitted") expect((await result).finalSubmittedAt).toEqual(time);
      else await expect(result).rejects.toMatchObject({ code: expected });
    }
  });
});
