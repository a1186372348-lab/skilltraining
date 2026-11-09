import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { abandonPack, createPack, getActivePack, getPack, getPackAvailability, openPackItem } from "./service";

const db = new PrismaClient();
const userIds: string[] = [];
const questionIds: string[] = [];
const dimension = "问题定义";

async function user(completed: boolean | null = true) {
  const row = await db.user.create({ data: {
    email: `t30-pack-${randomUUID()}@example.com`,
    ...(completed === null ? {} : { profile: { create: {
      position: "测试", yearsExperience: "1", industry: "测试", familiarProducts: [], interestAreas: [],
      selfAssessment: {}, baselineCompletedAt: completed ? new Date() : null,
    } } }),
  } });
  userIds.push(row.id);
  return row;
}

async function questions(difficulties = [1, 2, 3, 3, 4]) {
  const result = [];
  for (const difficulty of difficulties) {
    const row = await db.question.create({ data: {
      caseTitle: `合成题 ${randomUUID()}`, caseBackground: {}, mainQuestion: "问题", abilityTags: [dimension],
      difficulty, rubric: { private: "secret" }, hintTree: [], materials: {}, status: "published", kind: "daily",
    } });
    questionIds.push(row.id);
    result.push(row);
  }
  return result;
}

function weekStart(at: Date) {
  const days = (at.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - days));
}

async function plan(userId: string, status: "active" | "rejected" = "active", focusDimension = dimension) {
  return db.trainingPlan.create({ data: {
    userId, weekStartDate: weekStart(new Date()), focusDimension, status,
    startScore: 50, targetScore: 60, reason: "合成计划",
  } });
}

async function score(sessionId: string, value: number | null) {
  await db.trainingSession.update({ where: { id: sessionId }, data: {
    state: "scored", finalSubmittedAt: new Date(), scoredAt: new Date(),
    ...(value === null ? {} : { scores: { create: { dimension, rawScore: value, hintCount: 0, coefficient: 1, effectiveScore: value } } }),
  } });
}

beforeAll(async () => {
  const [row] = await db.$queryRaw<{ database: string; schema: string }[]>`SELECT current_database() AS database, current_schema() AS schema`;
  if (row.database !== "skilltraining_test" || !/^v2_core_20261103_[a-f0-9]+$/.test(row.schema)) throw new Error("测试数据库或隔离 schema 不匹配");
});
afterEach(async () => {
  await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  await db.question.deleteMany({ where: { id: { in: questionIds.splice(0) } } });
});
afterAll(async () => { await db.$disconnect(); });

describe("训练包服务的隔离数据库行为", () => {
  it("批量可用性只读，不建包、会话或计划，并区分同维与其他维活动包", async () => {
    const account = await user();
    // 显式制造已练的其他维度题，并隔离共享测试库中预先上架的日常题。
    const practiced = await db.question.create({ data: {
      caseTitle: `已练合成题 ${randomUUID()}`, caseBackground: {}, mainQuestion: "问题", abilityTags: ["用户理解"],
      difficulty: 2, rubric: {}, hintTree: [], materials: {}, status: "published", kind: "daily",
    } });
    questionIds.push(practiced.id);
    const existing = await db.question.findMany({
      where: { status: "published", kind: "daily" }, select: { id: true },
    });
    expect(existing.map(question => question.id)).toContain(practiced.id);
    await db.trainingSession.createMany({ data: existing.map(question => ({
      userId: account.id, questionId: question.id, date: new Date(), state: "abandoned" as const,
      isExtra: true, sourceType: "extra" as const,
    })) });
    await questions();
    const dimensions = [dimension, "用户理解"];
    const before = await Promise.all([
      db.trainingPack.count({ where: { userId: account.id } }),
      db.trainingSession.count({ where: { userId: account.id } }),
      db.trainingPlan.count({ where: { userId: account.id } }),
    ]);
    expect(before).toEqual([0, existing.length, 0]);
    const initial = await getPackAvailability(db, account.id, dimensions);
    expect(initial).toMatchObject([
      { dimension, status: "available", availableQuestions: 5, requiredQuestions: 5, activePackId: null },
      { dimension: "用户理解", status: "insufficient_questions", availableQuestions: 0, requiredQuestions: 5 },
    ]);
    const after = await Promise.all([
      db.trainingPack.count({ where: { userId: account.id } }),
      db.trainingSession.count({ where: { userId: account.id } }),
      db.trainingPlan.count({ where: { userId: account.id } }),
    ]);
    expect(after).toEqual(before);
    const pack = await createPack(db, account.id, dimension);
    expect(await getPackAvailability(db, account.id, dimensions)).toMatchObject([
      { status: "active_same_dimension", activePackId: pack.id, completedCount: 0 },
      { status: "active_other_dimension", activePackId: pack.id, completedCount: null },
    ]);
    const started = await openPackItem(db, account.id, pack.id, 0);
    await score(started.sessionId, 70);
    expect((await getPackAvailability(db, account.id, dimensions))[0].completedCount).toBe(1);
    expect((await db.packItem.findUniqueOrThrow({ where: { packId_orderIndex: { packId: pack.id, orderIndex: 1 } } })).unlockedAt).toBeNull();
    await db.userProfile.update({ where: { userId: account.id }, data: { baselineCompletedAt: null } });
    expect(await getPackAvailability(db, account.id, dimensions)).toMatchObject([
      { status: "baseline_required" }, { status: "baseline_required" },
    ]);
    await expect(getPackAvailability(db, account.id, ["无效维度"])).rejects.toMatchObject({ code: "INVALID_DIMENSION" });
  });

  it("活动包条目损坏时可用性不伪造完成数，也不自动修复", async () => {
    const account = await user();
    await questions();
    const pack = await createPack(db, account.id, dimension);
    await db.packItem.delete({ where: { packId_orderIndex: { packId: pack.id, orderIndex: 4 } } });
    expect(await getPackAvailability(db, account.id, [dimension])).toMatchObject([
      { status: "active_same_dimension", completedCount: null },
    ]);
    expect(await db.packItem.count({ where: { packId: pack.id } })).toBe(4);
  });

  it("未建画像、未完成基线不能开包；已开始基线后不能读取旧包或开题", async () => {
    const missing = await user(null);
    const incomplete = await user(false);
    const account = await user();
    const daily = await questions();
    await expect(createPack(db, missing.id, dimension)).rejects.toMatchObject({ code: "BASELINE_REQUIRED", httpStatus: 409 });
    await expect(createPack(db, incomplete.id, dimension)).rejects.toMatchObject({ code: "BASELINE_REQUIRED", httpStatus: 409 });
    const pack = await createPack(db, account.id, dimension);
    await db.userProfile.update({ where: { userId: account.id }, data: { baselineCompletedAt: null } });
    const baseline = await db.question.create({ data: {
      caseTitle: "合成基线题", caseBackground: {}, mainQuestion: "问题", abilityTags: [dimension],
      difficulty: 1, rubric: {}, hintTree: [], materials: {}, status: "published", kind: "baseline",
    } });
    questionIds.push(baseline.id);
    await db.trainingSession.create({ data: { userId: account.id, questionId: baseline.id, date: new Date(), sourceType: "baseline" } });
    await expect(getPack(db, account.id, pack.id)).rejects.toMatchObject({ code: "BASELINE_REQUIRED", httpStatus: 409 });
    await expect(openPackItem(db, account.id, pack.id, 0)).rejects.toMatchObject({ code: "BASELINE_REQUIRED", httpStatus: 409 });
    expect(await db.trainingPack.count({ where: { userId: { in: [missing.id, incomplete.id] } } })).toBe(0);
    expect(await db.trainingSession.count({ where: { userId: account.id, questionId: { in: daily.map(row => row.id) } } })).toBe(0);
  });

  it("无基线会话的旧用户可读已有包，但缺完成标记不能开启新题", async () => {
    const account = await user();
    await questions();
    const pack = await createPack(db, account.id, dimension);
    await db.userProfile.update({ where: { userId: account.id }, data: { baselineCompletedAt: null } });
    expect((await getPack(db, account.id, pack.id)).id).toBe(pack.id);
    await expect(openPackItem(db, account.id, pack.id, 0)).rejects.toMatchObject({ code: "BASELINE_REQUIRED" });
    expect(await db.trainingSession.count({ where: { userId: account.id } })).toBe(0);
  });
  it("题目不足或维度无效时拒绝且不写包", async () => {
    const account = await user();
    await questions([1, 2, 3, 4]);
    await expect(createPack(db, account.id, dimension)).rejects.toMatchObject({ code: "INSUFFICIENT_QUESTIONS" });
    await expect(createPack(db, account.id, "不存在的维度")).rejects.toMatchObject({ code: "INVALID_DIMENSION" });
    expect(await db.trainingPack.count({ where: { userId: account.id } })).toBe(0);
  });

  it("并发创建只保留一个 active 包；返回实际难度，不泄露评分标准", async () => {
    const account = await user();
    await questions([1, 2, 2, 3, 3]);
    const results = await Promise.allSettled([createPack(db, account.id, dimension), createPack(db, account.id, dimension)]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(row => row.status === "rejected")).toHaveLength(1);
    expect(await db.trainingPack.count({ where: { userId: account.id, status: "active" } })).toBe(1);
    const pack = await getActivePack(db, account.id);
    expect(pack?.items).toHaveLength(5);
    expect(pack?.items.some(item => item.substituted)).toBe(true);
    expect(pack?.items.every(item => item.actualDifficulty >= 1 && item.actualDifficulty <= 5)).toBe(true);
    expect(JSON.stringify(pack)).not.toContain("secret");
  });

  it("开题幂等、绑定本周同维计划；评分后才推进，最终按实际得分诊断", async () => {
    const account = await user();
    await questions();
    const currentPlan = await plan(account.id);
    const created = await createPack(db, account.id, dimension);
    await expect(openPackItem(db, account.id, created.id, 1)).rejects.toMatchObject({ code: "ITEM_LOCKED" });
    for (let index = 0; index < 5; index++) {
      const [opened, repeat] = await Promise.all([
        openPackItem(db, account.id, created.id, index), openPackItem(db, account.id, created.id, index),
      ]);
      expect(repeat.sessionId).toBe(opened.sessionId);
      const session = await db.trainingSession.findUniqueOrThrow({ where: { id: opened.sessionId } });
      expect(session).toMatchObject({ userId: account.id, sourceType: "pack", sourceId: created.id, isExtra: true, linkedPlanId: currentPlan.id });
      await score(opened.sessionId, index === 0 ? 0 : 70 + index);
      const view = await getPack(db, account.id, created.id);
      expect(view.items[index].effectiveScore).toBe(index === 0 ? 0 : 70 + index);
      if (index < 4) expect(view.items[index + 1].state).toBe("available");
    }
    const completed = await getPack(db, account.id, created.id);
    expect(completed.status).toBe("completed");
    expect(completed.endedAt).not.toBeNull();
    expect(completed.diagnosis.complete).toBe(true);
    expect(completed.diagnosis.trajectory[0].effectiveScore).toBe(0);
    expect(await getActivePack(db, account.id)).toBeNull();
  });

  it("未匹配或已拒绝的本周计划不绑定；他人不能读取或开启包", async () => {
    const account = await user();
    const other = await user();
    await questions();
    await plan(account.id, "rejected");
    const pack = await createPack(db, account.id, dimension);
    await expect(getPack(db, other.id, pack.id)).rejects.toMatchObject({ code: "PACK_NOT_FOUND" });
    await expect(openPackItem(db, other.id, pack.id, 0)).rejects.toMatchObject({ code: "PACK_NOT_FOUND" });
    const opened = await openPackItem(db, account.id, pack.id, 0);
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: opened.sessionId } })).linkedPlanId).toBeNull();
  });

  it("同周计划维度不匹配时不会自动绑定", async () => {
    const account = await user();
    await questions();
    await plan(account.id, "active", "产品表达");
    const pack = await createPack(db, account.id, dimension);
    const opened = await openPackItem(db, account.id, pack.id, 0);
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: opened.sessionId } })).linkedPlanId).toBeNull();
  });

  it("拒绝计划后新题不再关联，原题关联和评分不回写", async () => {
    const account = await user();
    await questions();
    const current = await plan(account.id);
    const pack = await createPack(db, account.id, dimension);
    const first = await openPackItem(db, account.id, pack.id, 0);
    await score(first.sessionId, 64);
    await db.trainingPlan.update({ where: { id: current.id }, data: { status: "rejected" } });
    const second = await openPackItem(db, account.id, pack.id, 1);
    const [savedFirst, savedSecond] = await Promise.all([
      db.trainingSession.findUniqueOrThrow({ where: { id: first.sessionId } }),
      db.trainingSession.findUniqueOrThrow({ where: { id: second.sessionId } }),
    ]);
    expect(savedFirst.linkedPlanId).toBe(current.id);
    expect(savedSecond.linkedPlanId).toBeNull();
    expect(await db.score.count({ where: { sessionId: first.sessionId, effectiveScore: 64 } })).toBe(1);
  });

  it("等待跨越 UTC 周界后按开题时的新周归属，重复开启不重新标记", async () => {
    const account = await user();
    await questions();
    const oldWeek = new Date("2026-10-26T00:00:00Z");
    const nextWeek = new Date("2026-11-02T00:00:00Z");
    for (const weekStartDate of [oldWeek, nextWeek]) {
      await db.trainingPlan.create({ data: {
        userId: account.id, weekStartDate, focusDimension: dimension, startScore: 50, targetScore: 60, reason: "合成计划",
      } });
    }
    const nextPlan = await db.trainingPlan.findUniqueOrThrow({ where: { userId_weekStartDate: { userId: account.id, weekStartDate: nextWeek } } });
    const pack = await createPack(db, account.id, dimension);
    const times = [new Date("2026-11-01T23:59:59Z"), new Date("2026-11-02T00:00:00Z")];
    let calls = 0;
    const opened = await openPackItem(db, account.id, pack.id, 0, { now: () => times[Math.min(calls++, 1)] });
    const saved = await db.trainingSession.findUniqueOrThrow({ where: { id: opened.sessionId } });
    expect(saved.linkedPlanId).toBe(nextPlan.id);
    expect(saved.date).toEqual(nextWeek);
    expect(saved.startedAt).toEqual(nextWeek);
    expect((await openPackItem(db, account.id, pack.id, 0, { now: () => new Date("2026-11-09T00:00:00Z") })).sessionId).toBe(opened.sessionId);
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: opened.sessionId } })).linkedPlanId).toBe(nextPlan.id);
  });

  it("关联到他人会话或来源不匹配时整体报错，不泄露分数", async () => {
    const account = await user();
    const other = await user();
    const rows = await questions();
    const pack = await createPack(db, account.id, dimension);
    const foreign = await db.trainingSession.create({ data: {
      userId: other.id, questionId: rows[0].id, date: new Date(), state: "scored", scoredAt: new Date(),
      scores: { create: { dimension, rawScore: 99, hintCount: 0, coefficient: 1, effectiveScore: 99 } },
    } });
    await db.packItem.update({ where: { packId_orderIndex: { packId: pack.id, orderIndex: 0 } }, data: { sessionId: foreign.id, startedAt: new Date() } });
    await expect(getPack(db, account.id, pack.id)).rejects.toMatchObject({ code: "ITEM_INCONSISTENT" });
    await expect(openPackItem(db, account.id, pack.id, 0)).rejects.toMatchObject({ code: "ITEM_INCONSISTENT" });
  });

  it("目标维评分丢失、会话删除或包缺项均不创建新题、不解锁", async () => {
    const account = await user();
    await questions();
    const pack = await createPack(db, account.id, dimension);
    const opened = await openPackItem(db, account.id, pack.id, 0);
    await score(opened.sessionId, null);
    const corrupt = await getPack(db, account.id, pack.id);
    expect(corrupt.items[0].state).toBe("inconsistent");
    expect(corrupt.items[1].state).toBe("locked");
    await db.trainingSession.delete({ where: { id: opened.sessionId } });
    expect((await getPack(db, account.id, pack.id)).items[0].state).toBe("inconsistent");
    await expect(openPackItem(db, account.id, pack.id, 0)).rejects.toMatchObject({ code: "ITEM_INCONSISTENT" });
    expect(await db.trainingSession.count({ where: { userId: account.id } })).toBe(0);
    await db.packItem.delete({ where: { packId_orderIndex: { packId: pack.id, orderIndex: 4 } } });
    await expect(getPack(db, account.id, pack.id)).rejects.toMatchObject({ code: "ITEM_INCONSISTENT" });
  });

  it("后续条目意外提前解锁时整包待恢复，不允许创建任何新会话", async () => {
    const account = await user();
    await questions();
    const pack = await createPack(db, account.id, dimension);
    await db.packItem.update({ where: { packId_orderIndex: { packId: pack.id, orderIndex: 1 } }, data: { unlockedAt: new Date() } });
    expect((await getPack(db, account.id, pack.id)).items[1].state).toBe("inconsistent");
    await expect(openPackItem(db, account.id, pack.id, 0)).rejects.toMatchObject({ code: "ITEM_INCONSISTENT" });
    expect(await db.trainingSession.count({ where: { userId: account.id } })).toBe(0);
  });

  it("题目归档后不可新开，已创建会话仍可恢复；普通会话进行中不可另开包题", async () => {
    const account = await user();
    const rows = await questions();
    const pack = await createPack(db, account.id, dimension);
    await db.question.update({ where: { id: pack.items[0].questionId }, data: { status: "archived" } });
    expect((await getPack(db, account.id, pack.id)).items[0].state).toBe("unavailable");
    await expect(openPackItem(db, account.id, pack.id, 0)).rejects.toMatchObject({ code: "QUESTION_UNAVAILABLE" });
    await db.question.update({ where: { id: pack.items[0].questionId }, data: { status: "published" } });
    const ordinary = await db.trainingSession.create({ data: { userId: account.id, questionId: rows[0].id, date: new Date(), state: "reading" } });
    await expect(openPackItem(db, account.id, pack.id, 0)).rejects.toMatchObject({ code: "SESSION_IN_PROGRESS" });
    await db.trainingSession.update({ where: { id: ordinary.id }, data: { state: "abandoned" } });
    const opened = await openPackItem(db, account.id, pack.id, 0);
    await db.question.update({ where: { id: pack.items[0].questionId }, data: { status: "archived" } });
    expect((await openPackItem(db, account.id, pack.id, 0)).sessionId).toBe(opened.sessionId);
  });

  it("确认放弃才终止未交终答的当前会话并结束整包，已交终答成绩可继续保留", async () => {
    const account = await user();
    await questions();
    const pack = await createPack(db, account.id, dimension);
    const opened = await openPackItem(db, account.id, pack.id, 0);
    await expect(abandonPack(db, account.id, pack.id, { confirmed: false })).rejects.toThrow();
    expect((await getPack(db, account.id, pack.id)).status).toBe("active");
    const abandoned = await abandonPack(db, account.id, pack.id, { confirmed: true });
    expect(abandoned.status).toBe("abandoned");
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: opened.sessionId } })).state).toBe("abandoned");
    expect((await abandonPack(db, account.id, pack.id, { confirmed: true })).status).toBe("abandoned");
    await expect(openPackItem(db, account.id, pack.id, 1)).rejects.toMatchObject({ code: "PACK_NOT_ACTIVE" });
  });

  it("放弃先于最终评分时不再解锁，迟到的评分仍留在原会话", async () => {
    const account = await user();
    await questions();
    const pack = await createPack(db, account.id, dimension);
    const opened = await openPackItem(db, account.id, pack.id, 0);
    await db.trainingSession.update({ where: { id: opened.sessionId }, data: {
      state: "followup", firstAnswer: "首答", finalAnswer: "合成答案", finalSubmittedAt: new Date(),
    } });
    await abandonPack(db, account.id, pack.id, { confirmed: true });
    await score(opened.sessionId, 78);
    const result = await getPack(db, account.id, pack.id);
    expect(result.status).toBe("abandoned");
    expect(result.items[0].effectiveScore).toBe(78);
    expect(result.items[1].state).toBe("locked");
  });
});
