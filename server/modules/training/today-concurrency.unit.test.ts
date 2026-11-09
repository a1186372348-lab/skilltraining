import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pack: vi.fn(), pickRetest: vi.fn(), select: vi.fn() }));
vi.mock("./pack-entry", () => ({ resolveActivePackSession: mocks.pack }));
vi.mock("./retest-entry", () => ({ pickRetestInTransaction: mocks.pickRetest }));
vi.mock("@/server/modules/selection/service", () => ({ selectTodayQuestion: mocks.select }));

import { getOrCreateTodaySession, todayUtc } from "./service";
import { SelectionError } from "@/server/modules/selection/errors";

const userId = "00000000-0000-4000-8000-000000000001";

type Row = {
  id: string;
  userId: string;
  date: Date;
  isExtra: boolean;
  sourceType: string;
  sourceId: string | null;
  state: string;
  finalSubmittedAt: Date | null;
  question: { id: string; kind: string };
};
type Filter = {
  id?: string;
  userId?: string;
  date?: Date;
  isExtra?: boolean;
  sourceType?: string | { not?: string; notIn?: string[] };
  sourceId?: string;
  state?: string | { not?: string; notIn?: string[]; in?: string[] };
  question?: { kind?: string };
};

function matchesValue(value: string, filter?: string | { not?: string; notIn?: string[]; in?: string[] }): boolean {
  if (!filter) return true;
  if (typeof filter === "string") return value === filter;
  return value !== filter.not && !filter.notIn?.includes(value) && (!filter.in || filter.in.includes(value));
}

function matches(row: Row, where: Filter): boolean {
  return (!where.id || row.id === where.id)
    && (!where.userId || row.userId === where.userId)
    && (!where.date || row.date.getTime() === where.date.getTime())
    && (where.isExtra === undefined || row.isExtra === where.isExtra)
    && matchesValue(row.sourceType, where.sourceType)
    && (!where.sourceId || row.sourceId === where.sourceId)
    && matchesValue(row.state, where.state)
    && (!where.question?.kind || row.question.kind === where.question.kind);
}

function fakeDb(rows: Row[]) {
  const findFirst = vi.fn(async ({ where }: { where: Filter }) => rows.find(row => matches(row, where)) ?? null);
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "unexpected-new-session", ...data }));
  const tx = { $queryRaw: async () => [{ id: userId }], trainingSession: { findFirst, create } };
  return { db: { $transaction: async (run: (client: typeof tx) => unknown) => run(tx) } as unknown as PrismaClient, create };
}

function row(id: string, sourceType: string, state: string, isExtra: boolean): Row {
  return { id, userId, date: todayUtc(), isExtra, sourceType, state,
    sourceId: sourceType === "retest" ? "trigger" : null,
    finalSubmittedAt: state === "followup" ? new Date() : null, question: { id: `q-${id}`, kind: "daily" } };
}

beforeEach(() => {
  mocks.pack.mockReset().mockResolvedValue({ active: false, session: null, reservedQuestionIds: [] });
  mocks.pickRetest.mockReset().mockResolvedValue({ question: { id: "q-retest" }, sessionId: "retest", triggerId: "trigger", dimension: "问题定义" });
  mocks.select.mockReset().mockImplementation(async (_db, _userId, options) => {
    const retest = await options.pickRetest?.();
    return retest
      ? { question: retest.question, outcome: { sourceType: "retest", sourceId: retest.triggerId }, retestSessionId: retest.sessionId }
      : { question: { id: "new-question" }, outcome: { sourceType: "daily", sourceId: null } };
  });
});

describe("自动推荐在用户锁内恢复普通训练", () => {
  it.each([
    ["auto", false, "reading"],
    ["daily", false, "reading"],
    ["auto", true, "reading"],
    ["auto", true, "followup"],
  ] as const)("%s 模式下复用未完成加练（已完成日常：%s，状态：%s）", async (mode, hasCompletedDaily, state) => {
    const extra = row("extra", "extra", state, true);
    const rows = [extra, row("retest", "retest", "reading", true)];
    if (hasCompletedDaily) rows.push(row("done", "daily", "scored", false));
    const { db, create } = fakeDb(rows);

    const result = await getOrCreateTodaySession(db, userId, { mode });

    expect(result.session.id).toBe(extra.id);
    expect(mocks.pickRetest).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("已终止加练和独立复测不会占据普通训练槽", async () => {
    const retest = row("retest", "retest", "reading", true);
    const { db } = fakeDb([row("abandoned", "extra", "abandoned", true), retest]);

    const result = await getOrCreateTodaySession(db, userId);

    expect(result.session.id).toBe(retest.id);
    expect(mocks.pickRetest).toHaveBeenCalledOnce();
  });

  it("复测不可用且题库无上架题时仍展示已完成的加练", async () => {
    const completed = row("completed", "extra", "scored", true);
    const { db } = fakeDb([completed]);
    mocks.pickRetest.mockResolvedValue(null);
    mocks.select.mockImplementation(async (_db, _userId, options) => {
      await options.pickRetest?.();
      throw new SelectionError("NO_PUBLISHED_QUESTION", 404, "无题");
    });

    const result = await getOrCreateTodaySession(db, userId, { completedFallbackId: completed.id });

    expect(result.session.id).toBe(completed.id);
    expect(mocks.pickRetest).toHaveBeenCalledOnce();
  });

  it("已有完成题时其他选题错误仍需向上报告", async () => {
    const completed = row("completed", "extra", "scored", true);
    const { db } = fakeDb([completed]);
    const failure = new Error("storage failure");
    mocks.select.mockRejectedValue(failure);

    await expect(getOrCreateTodaySession(db, userId, { completedFallbackId: completed.id })).rejects.toBe(failure);
  });

  it("尚未检查复测便选题失败时，不把错误伪装为完成题回退", async () => {
    const completed = row("completed", "extra", "scored", true);
    const { db } = fakeDb([completed]);
    mocks.select.mockRejectedValue(new SelectionError("NO_PUBLISHED_QUESTION", 404, "无题"));

    await expect(getOrCreateTodaySession(db, userId, { completedFallbackId: completed.id }))
      .rejects.toMatchObject({ code: "NO_PUBLISHED_QUESTION" });
    expect(mocks.pickRetest).not.toHaveBeenCalled();
  });
});
