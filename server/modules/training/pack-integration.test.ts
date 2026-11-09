import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPack, openPackItem } from "@/server/modules/packs";
import { getPlanProgress, setCurrentPlanStatus, weekStartUtc } from "@/server/modules/planning";
import { scoreSession } from "@/server/modules/scoring/service";
import { abandonSession, getLatestDailySession, getOrCreateExtraSession, getOrCreateTodaySession, submitFinalAnswer, todayUtc } from "./service";

const db = new PrismaClient();
const userIds: string[] = [];
const questionIds: string[] = [];
const dimension = "问题定义";

async function fixture() {
  const user = await db.user.create({ data: {
    email: `t30-shared-${randomUUID()}@example.com`, profile: { create: {
      position: "测试", yearsExperience: "1", industry: "测试", familiarProducts: [], interestAreas: [],
      selfAssessment: {}, baselineCompletedAt: new Date(),
    } },
  } });
  userIds.push(user.id);
  const questions = [];
  for (const difficulty of [1, 1, 2, 2, 3, 3, 4, 4]) {
    const row = await db.question.create({ data: {
      caseTitle: `接线测试 ${randomUUID()}`, caseBackground: {}, mainQuestion: "问题", abilityTags: [dimension],
      difficulty, rubric: { dimensions: { [dimension]: ["标准"] } }, hintTree: [], materials: {}, status: "published", kind: "daily",
    } });
    questionIds.push(row.id);
    questions.push(row);
  }
  return { user, questions };
}

async function markScored(sessionId: string, scoredAt = new Date()) {
  await db.trainingSession.update({ where: { id: sessionId }, data: {
    state: "scored", firstAnswer: "首答", finalAnswer: "终答", finalSubmittedAt: scoredAt, scoredAt,
    scores: { create: { dimension, rawScore: 70, hintCount: 0, coefficient: 1, effectiveScore: 70 } },
  } });
}

beforeAll(async () => {
  const [row] = await db.$queryRaw<{ database: string; schema: string }[]>`SELECT current_database() AS database, current_schema() AS schema`;
  if (row.database !== "skilltraining_test" || !/^v2_core_20261103_[a-f0-9]{12}$/.test(row.schema)) throw new Error("测试库隔离不匹配");
});
afterEach(async () => {
  await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  await db.question.deleteMany({ where: { id: { in: questionIds.splice(0) } } });
});
afterAll(async () => { await db.$disconnect(); });

describe("训练包与共享训练入口的隔离数据库接线", () => {
  it("今日与显式加练并发时只保留一个未完成会话，加练不占包预留题", async () => {
    const { user } = await fixture();
    const pack = await createPack(db, user.id, dimension);
    const reserved = new Set(pack.items.map(item => item.questionId));
    const results = await Promise.allSettled([
      getOrCreateTodaySession(db, user.id), getOrCreateTodaySession(db, user.id), getOrCreateExtraSession(db, user.id),
    ]);
    const fulfilled = results.filter(result => result.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(2);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "SESSION_IN_PROGRESS" });
    const sessions = await db.trainingSession.findMany({ where: { userId: user.id, finalSubmittedAt: null, state: { not: "abandoned" } } });
    expect(sessions).toHaveLength(1);
    if (sessions[0].sourceType === "extra") expect(reserved.has(sessions[0].questionId)).toBe(false);
    else expect(sessions[0]).toMatchObject({ sourceType: "pack", sourceId: pack.id });
  });

  it("已开始普通题时今日继续原会话，直接开包题返回冲突", async () => {
    const { user, questions } = await fixture();
    const ordinary = await db.trainingSession.create({ data: { userId: user.id, questionId: questions[0].id, date: todayUtc(), state: "reading", sourceType: "daily" } });
    const pack = await createPack(db, user.id, dimension);
    expect((await getOrCreateTodaySession(db, user.id)).session.id).toBe(ordinary.id);
    await expect(openPackItem(db, user.id, pack.id, 0)).rejects.toMatchObject({ code: "SESSION_IN_PROGRESS" });
    expect(await db.trainingSession.count({ where: { userId: user.id } })).toBe(1);
  });

  it("评分中不越级，缺分明确阻断且不新建普通题", async () => {
    const { user } = await fixture();
    await createPack(db, user.id, dimension);
    const current = (await getOrCreateTodaySession(db, user.id)).session;
    await db.trainingSession.update({ where: { id: current.id }, data: { state: "followup", finalAnswer: "终答", finalSubmittedAt: new Date() } });
    expect((await getOrCreateTodaySession(db, user.id)).session.id).toBe(current.id);
    await db.trainingSession.update({ where: { id: current.id }, data: { state: "scored", scoredAt: new Date() } });
    await expect(getOrCreateTodaySession(db, user.id)).rejects.toMatchObject({ code: "ITEM_INCONSISTENT" });
    expect(await db.trainingSession.count({ where: { userId: user.id } })).toBe(1);
  });

  it("包题已提交后显式加练保留 extra 来源，且不占用任何包预留题", async () => {
    const { user } = await fixture();
    const pack = await createPack(db, user.id, dimension);
    const current = (await getOrCreateTodaySession(db, user.id)).session;
    await db.trainingSession.update({ where: { id: current.id }, data: {
      state: "followup", firstSubmittedAt: new Date(), finalAnswer: "终答", finalSubmittedAt: new Date(),
    } });
    const extra = (await getOrCreateExtraSession(db, user.id)).session;
    expect(extra).toMatchObject({ sourceType: "extra", sourceId: null, isExtra: true });
    expect(pack.items.map(item => item.questionId)).not.toContain(extra.questionId);
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: current.id } })).sourceType).toBe("pack");
    expect((await getOrCreateTodaySession(db, user.id)).session.id).toBe(extra.id);
  });

  it("漏回调可读时恢复下一题；确认弃包与当前题原子终止并保留既有成绩", async () => {
    const { user } = await fixture();
    const pack = await createPack(db, user.id, dimension);
    const first = (await getOrCreateTodaySession(db, user.id)).session;
    await markScored(first.id);
    expect(await getLatestDailySession(db, user.id)).toBeNull();
    const second = (await getOrCreateTodaySession(db, user.id)).session;
    expect(second.id).not.toBe(first.id);
    await expect(abandonSession(db, second.id, user.id)).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect((await db.trainingPack.findUniqueOrThrow({ where: { id: pack.id } })).status).toBe("active");
    await expect(abandonSession(db, first.id, user.id, { confirmAbandonPack: true })).rejects.toMatchObject({ code: "SESSION_ALREADY_SCORED" });
    expect(await abandonSession(db, second.id, user.id, { confirmAbandonPack: true })).toEqual({ state: "abandoned" });
    expect((await db.trainingPack.findUniqueOrThrow({ where: { id: pack.id } })).status).toBe("abandoned");
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: second.id } })).state).toBe("abandoned");
    expect(await db.score.count({ where: { sessionId: first.id, effectiveScore: 70 } })).toBe(1);
  });

  it("评分提交后推进失败不影响结果，后续读取可恢复包进度", async () => {
    const { user } = await fixture();
    await createPack(db, user.id, dimension);
    const first = (await getOrCreateTodaySession(db, user.id)).session;
    await db.trainingSession.update({ where: { id: first.id }, data: {
      state: "followup", firstAnswer: "首答", finalAnswer: "终答", finalSubmittedAt: new Date(),
    } });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await scoreSession(db, first.id, user.id, {
        scoreWithRubric: async () => ({ dimensions: [{ dimension, rawScore: 70, diagnosis: "诊断" }], topIssue: "问题", nextFocus: "建议", confidence: null }),
        afterPackScored: async () => { throw new Error("sensitive-details"); },
      });
      expect(result.state).toBe("scored");
      expect(JSON.stringify(warning.mock.calls)).not.toContain("sensitive-details");
      expect((await db.trainingSession.findUniqueOrThrow({ where: { id: first.id } })).state).toBe("scored");
      expect((await getOrCreateTodaySession(db, user.id)).session.id).not.toBe(first.id);
    } finally { warning.mockRestore(); }
  });

  it("并发评分落败后也执行推进钩子并返回已提交的评分", async () => {
    const { user } = await fixture();
    const pack = await createPack(db, user.id, dimension);
    const first = (await getOrCreateTodaySession(db, user.id)).session;
    await db.trainingSession.update({ where: { id: first.id }, data: {
      state: "followup", firstAnswer: "首答", finalAnswer: "终答", finalSubmittedAt: new Date(),
    } });
    const scored = { dimensions: [{ dimension, rawScore: 70, diagnosis: "诊断" }], topIssue: "问题", nextFocus: "建议", confidence: null };
    const afterPackScored = vi.fn(async () => {});
    const result = await scoreSession(db, first.id, user.id, {
      scoreWithRubric: async () => {
        await scoreSession(db, first.id, user.id, { scoreWithRubric: async () => scored });
        return scored;
      },
      afterPackScored,
    });
    expect(result.state).toBe("scored");
    expect(afterPackScored).toHaveBeenCalledWith(db, user.id, pack.id);
    expect(await db.score.count({ where: { sessionId: first.id } })).toBe(1);
  });

  it("拒绝计划保留已有包题关联和进度，新开题不再关联", async () => {
    const { user } = await fixture();
    const plan = await db.trainingPlan.create({ data: {
      userId: user.id, weekStartDate: weekStartUtc(new Date()), focusDimension: dimension,
      startScore: 50, targetScore: 60, reason: "测试", status: "active",
    } });
    await createPack(db, user.id, dimension);
    const first = (await getOrCreateTodaySession(db, user.id)).session;
    expect(first.linkedPlanId).toBe(plan.id);
    await markScored(first.id);
    await setCurrentPlanStatus(db, user.id, "rejected");
    const second = (await getOrCreateTodaySession(db, user.id)).session;
    expect(second.linkedPlanId).toBeNull();
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: first.id } })).linkedPlanId).toBe(plan.id);
    const progress = await getPlanProgress(db, user.id, plan);
    expect(progress.scoredCount).toBe(1);
  });

  it("并发提交终答与确认弃包时，两种成功结果互不矛盾", async () => {
    const { user } = await fixture();
    const pack = await createPack(db, user.id, dimension);
    const current = (await getOrCreateTodaySession(db, user.id)).session;
    await db.trainingSession.update({ where: { id: current.id }, data: {
      state: "followup", firstAnswer: "首答", firstSubmittedAt: new Date(),
    } });
    const results = await Promise.allSettled([
      submitFinalAnswer(db, current.id, user.id, "终答"),
      abandonSession(db, current.id, user.id, { confirmAbandonPack: true }),
    ]);
    const [session, savedPack] = await Promise.all([
      db.trainingSession.findUniqueOrThrow({ where: { id: current.id } }),
      db.trainingPack.findUniqueOrThrow({ where: { id: pack.id } }),
    ]);
    if (session.state === "abandoned") {
      expect(session.finalSubmittedAt).toBeNull();
      expect(savedPack.status).toBe("abandoned");
      expect(results[0].status).toBe("rejected");
    } else {
      expect(session.finalSubmittedAt).not.toBeNull();
      expect(savedPack.status).toBe("active");
      expect(results[1].status).toBe("rejected");
    }
  });
});
