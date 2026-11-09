import { describe, expect, it, vi } from "vitest";

import { nextPackAction, resolveActivePackSession } from "./pack-entry";

const item = (orderIndex: number, state: string, sessionId: string | null = null) => ({ orderIndex, state, sessionId });

describe("今日训练的包优先决策", () => {
  it("首题已解锁但未开题时应开启该题", () => {
    expect(nextPackAction([item(0, "available"), ...[1, 2, 3, 4].map(i => item(i, "locked"))] as never))
      .toEqual({ kind: "open", orderIndex: 0 });
  });

  it("评分中复用当前会话，不能打开下一题", () => {
    expect(nextPackAction([item(0, "awaiting_score", "s1"), ...[1, 2, 3, 4].map(i => item(i, "locked"))] as never))
      .toEqual({ kind: "resume", sessionId: "s1" });
  });

  it("损坏或矛盾状态明确失败，不能降级为普通题", () => {
    expect(() => nextPackAction([item(0, "inconsistent"), ...[1, 2, 3, 4].map(i => item(i, "locked"))] as never)).toThrow();
    expect(() => nextPackAction([item(0, "in_progress"), ...[1, 2, 3, 4].map(i => item(i, "locked"))] as never)).toThrow();
    expect(() => nextPackAction([item(0, "awaiting_score", "s1"), item(1, "available")] as never)).toThrow();
  });

  it("只读查询发现可开题时保留包优先，不先创建或返回普通已完成题", async () => {
    const findFirst = vi.fn(async () => null);
    const context = { userId: "u", tx: { trainingPack: { findFirst: vi.fn(async () => ({ id: "p" })) }, trainingSession: { findFirst } } } as never;
    const getActive = vi.fn(async () => ({ id: "p", items: [
      { ...item(0, "available"), questionId: "q0" }, ...[1, 2, 3, 4].map(i => ({ ...item(i, "locked"), questionId: `q${i}` })),
    ] }));
    const openItem = vi.fn();
    const result = await resolveActivePackSession(context, false, { getActive, openItem } as never);
    expect(result).toMatchObject({ active: true, session: null, reservedQuestionIds: ["q0", "q1", "q2", "q3", "q4"] });
    expect(openItem).not.toHaveBeenCalled();
  });

  it("评分中返回本人包会话，不重复开题", async () => {
    const owned = { id: "s1", userId: "u", sourceType: "pack", sourceId: "p", question: { id: "q0" } };
    const findFirst = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(owned);
    const context = { userId: "u", tx: { trainingPack: { findFirst: vi.fn(async () => ({ id: "p" })) }, trainingSession: { findFirst } } } as never;
    const getActive = vi.fn(async () => ({ id: "p", items: [
      { ...item(0, "awaiting_score", "s1"), questionId: "q0" }, ...[1, 2, 3, 4].map(i => ({ ...item(i, "locked"), questionId: `q${i}` })),
    ] }));
    const openItem = vi.fn();
    const result = await resolveActivePackSession(context, true, { getActive, openItem } as never);
    expect(result.session).toEqual(owned);
    expect(openItem).not.toHaveBeenCalled();
  });

  it("没有活动包时不调用包域的基线可见性守卫，保留普通训练原行为", async () => {
    const findFirst = vi.fn(async () => null);
    const context = { userId: "u", tx: { trainingPack: { findFirst } } } as never;
    const getActive = vi.fn();
    const result = await resolveActivePackSession(context, false, { getActive, openItem: vi.fn() } as never);
    expect(findFirst).toHaveBeenCalledWith({ where: { userId: "u", status: "active" }, select: { id: true } });
    expect(result).toEqual({ active: false, session: null, reservedQuestionIds: [] });
    expect(getActive).not.toHaveBeenCalled();
  });
});
