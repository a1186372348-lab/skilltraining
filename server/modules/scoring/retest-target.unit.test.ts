import type { PrismaClient, TrainingSession } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { assertRetestTarget } from "./retest-target";

const session = { id: "s", userId: "u", questionId: "q", sourceType: "retest", sourceId: "trigger" } as TrainingSession;

describe("复测评分目标维校验", () => {
  it("非复测跳过查询；有效本人复测必须匹配活动尝试及非空目标标准", async () => {
    const findFirst = vi.fn(async () => ({ dimension: "问题定义" }));
    const db = { retestAttempt: { findFirst } } as unknown as PrismaClient;
    await assertRetestTarget(db, { ...session, sourceType: "daily" }, {});
    expect(findFirst).not.toHaveBeenCalled();
    await assertRetestTarget(db, session, { 问题定义: ["标准"] });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      userId: "u", sessionId: "s", originalSessionId: "s", triggerId: "trigger", questionId: "q", status: "active",
    } }));
  });

  it("缺来源、缺尝试或目标评分标准为空时明确拒绝", async () => {
    const db = { retestAttempt: { findFirst: vi.fn(async () => null) } } as unknown as PrismaClient;
    await expect(assertRetestTarget(db, { ...session, sourceId: null }, {})).rejects.toMatchObject({ code: "QUESTION_RUBRIC_INVALID" });
    await expect(assertRetestTarget(db, session, {})).rejects.toMatchObject({ code: "QUESTION_RUBRIC_INVALID" });
    const matching = { retestAttempt: { findFirst: vi.fn(async () => ({ dimension: "问题定义" })) } } as unknown as PrismaClient;
    await expect(assertRetestTarget(matching, session, { 问题定义: ["  "] })).rejects.toMatchObject({ httpStatus: 409 });
  });
});
