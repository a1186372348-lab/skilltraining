import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";
import { questionUuid } from "@/server/modules/content/question-id";
import { getBaselineStatus, getOrCreateBaselineSession } from "./service";
import { scoreSession } from "@/server/modules/scoring/service";
import { selectQuestion } from "@/server/modules/selection/engine";

const db = new PrismaClient();
const questionIds = ABILITY_DIMENSIONS.flatMap(() => [randomUUID(), randomUUID()].sort());
const createdQuestionIds: string[] = [];
const users: string[] = [];
async function user(completedAt: Date | null = null) {
  const row = await db.user.create({ data: { email: `baseline-${randomUUID()}@example.com`, profile: { create: { position: "测试", yearsExperience: "1", industry: "测试", familiarProducts: [], interestAreas: [], selfAssessment: {}, baselineCompletedAt: completedAt } } } });
  users.push(row.id);
  return row.id;
}
async function score(userId: string, questionId: string, confidence: number | null = 90) {
  const existing = await db.trainingSession.findFirst({ where: { userId, questionId } });
  const session = existing ?? await db.trainingSession.create({ data: { userId, questionId, date: new Date(), isExtra: true, sourceType: "baseline" } });
  await db.trainingSession.update({ where: { id: session.id }, data: { finalSubmittedAt: new Date(), scoredAt: new Date(), state: "scored" } });
  await db.score.create({ data: { sessionId: session.id, dimension: ABILITY_DIMENSIONS[0], rawScore: 75, hintCount: 0, coefficient: 1, effectiveScore: 75, confidence } });
}
beforeAll(async () => {
  for (const [i, dimension] of ABILITY_DIMENSIONS.entries()) {
    for (const j of [0, 1]) {
      await db.question.create({ data: { id: questionIds[i * 2 + j], caseTitle: `测试 ${i}-${j}`, caseBackground: {}, mainQuestion: "测试", abilityTags: [dimension], difficulty: 1, rubric: { dimensions: { [dimension]: ["测试评分点"] } }, hintTree: {}, materials: {}, status: "published", kind: "baseline" } });
      createdQuestionIds.push(questionIds[i * 2 + j]);
    }
  }
});
afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.question.deleteMany({ where: { id: { in: createdQuestionIds } } });
  await db.$disconnect();
});

describe("真实数据库：八维基线", () => {
  it("并发状态与创建保持会话幂等、来源隔离及断点", async () => {
    const uid = await user();
    const statuses = await Promise.all([getBaselineStatus(db, uid), getBaselineStatus(db, uid)]);
    expect(statuses.every((s) => s.total === 8 && s.required)).toBe(true);
    const created = await Promise.all([getOrCreateBaselineSession(db, uid), getOrCreateBaselineSession(db, uid)]);
    expect(created[0].session.id).toBe(created[1].session.id);
    const rows = await db.trainingSession.findMany({ where: { userId: uid } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isExtra: true, sourceType: "baseline", hintCount: 0, followupHintCount: 0 });
    expect((await getOrCreateBaselineSession(db, uid)).session.id).toBe(rows[0].id);
    expect(await db.abilityProfile.count({ where: { userId: uid } })).toBe(0);
    expect(await db.sessionFeedback.count({ where: { session: { userId: uid } } })).toBe(0);
    expect((await db.userProfile.findUniqueOrThrow({ where: { userId: uid } })).baselineCompletedAt).toBeNull();
  });
  it("晚到低置信度不挤掉已展示补测，评分全部完成后才放行", async () => {
    const uid = await user();
    for (let i = 4; i < 8; i++) await score(uid, questionIds[i * 2], 20);
    const first = await getBaselineStatus(db, uid);
    const extras = first.items.filter((x) => x.isDeepen).map((x) => x.questionId);
    expect(extras).toEqual([4, 5, 6, 7].map((i) => questionIds[i * 2 + 1]));
    for (let i = 0; i < 4; i++) await score(uid, questionIds[i * 2], 20);
    const later = await getBaselineStatus(db, uid);
    expect(later.total).toBe(12);
    expect(later.items.filter((x) => x.isDeepen).map((x) => x.questionId)).toEqual(extras);
    expect(later.required).toBe(true);
    for (const id of extras) await score(uid, id);
    const finished = await getBaselineStatus(db, uid);
    expect(finished.required).toBe(false);
    expect(finished.completedAt).not.toBeNull();
    expect((await getBaselineStatus(db, uid)).completedAt).toEqual(finished.completedAt);
  });
  it("缺维不能完成，旧完成用户仍放行", async () => {
    const uid = await user();
    const old = await user(new Date("2020-01-01T00:00:00Z"));
    await db.question.updateMany({ where: { id: { in: questionIds.slice(-2) } }, data: { status: "draft" } });
    try {
      for (let i = 0; i < 7; i++) await score(uid, questionIds[i * 2]);
      const missing = await getBaselineStatus(db, uid);
      expect(missing.required).toBe(true);
      expect(missing.completedAt).toBeNull();
      expect((await getBaselineStatus(db, old)).required).toBe(false);
    } finally {
      await db.question.updateMany({ where: { id: { in: questionIds.slice(-2) } }, data: { status: "published" } });
    }
  });
});


it("并发查询补测时只预建一次，未评分补测阻止完成", async () => {
  const uid = await user();
  for (let i = 0; i < 8; i++) await score(uid, questionIds[i * 2], i < 4 ? 20 : 90);
  const statuses = await Promise.all([getBaselineStatus(db, uid), getBaselineStatus(db, uid)]);
  expect(statuses.every((status) => status.total === 12 && status.required)).toBe(true);
  const rows = await db.trainingSession.findMany({ where: { userId: uid, questionId: { in: questionIds.filter((_, i) => i % 2 === 1) } } });
  expect(rows).toHaveLength(4);
  expect(new Set(rows.map((row) => row.questionId)).size).toBe(4);
  const sessions = await Promise.all([getOrCreateBaselineSession(db, uid), getOrCreateBaselineSession(db, uid)]);
  expect(sessions[0].session.id).toBe(sessions[1].session.id);
  await db.trainingSession.update({ where: { id: rows[0].id }, data: { finalSubmittedAt: new Date() } });
  const pending = await getBaselineStatus(db, uid);
  expect(pending.required).toBe(true);
  expect(pending.pendingScoringSessionIds).toContain(rows[0].id);
  expect(pending.completedAt).toBeNull();
});


it("真实评分链路点亮八维，完成后选题进入强化期", async () => {
  const uid = await user();
  for (const dimension of ABILITY_DIMENSIONS) {
    const { session } = await getOrCreateBaselineSession(db, uid);
    await db.trainingSession.update({ where: { id: session.id }, data: { state: "followup", finalAnswer: "测试答案", finalSubmittedAt: new Date() } });
    await scoreSession(db, session.id, uid, { scoreWithRubric: async () => ({ dimensions: [{ dimension, rawScore: 75, diagnosis: "测试诊断" }], topIssue: "测试中需要补充指标", nextFocus: "下次明确验证指标", confidence: 90 }) });
  }
  expect((await getBaselineStatus(db, uid)).required).toBe(false);
  const rows = await db.abilityProfile.findMany({ where: { userId: uid } });
  expect(rows).toHaveLength(8);
  const profile = rows.map((row) => ({ dimension: row.dimension, observed: row.observationCount > 0, currentScore: row.currentScore, hintDependency: row.hintDependency, hintDependencyBand: null }));
  const outcome = selectQuestion({ profile, familiarProducts: [], interestAreas: [], practicedQuestionIds: new Set(), recentCaseBackgrounds: [], isFirstTraining: false, questions: [{ id: "daily", caseTitle: "测试日常题", caseBackground: {}, mainQuestion: "测试", abilityTags: [ABILITY_DIMENSIONS[0]], difficulty: 2 }] });
  expect(outcome?.phase).toBe("strengthening");
});

it("空题库保持日常放行", async () => {
  const uid = await user();
  await db.question.updateMany({ where: { id: { in: questionIds } }, data: { status: "draft" } });
  try {
    const status = await getBaselineStatus(db, uid);
    expect(status.required).toBe(false);
    expect(status.total).toBe(0);
    expect(status.completedAt).toBeNull();
  } finally {
    await db.question.updateMany({ where: { id: { in: questionIds } }, data: { status: "published" } });
  }
});

it("状态查询与会话创建混合并发时补测锁定、数量与断点保持一致", async () => {
  const uid = await user();
  for (let i = 6; i < 8; i++) await score(uid, questionIds[i * 2], 20);
  const initial = await getBaselineStatus(db, uid);
  const locked = initial.items.filter((item) => item.isDeepen).map((item) => item.questionId);
  for (let i = 0; i < 6; i++) await score(uid, questionIds[i * 2], 20);
  const [statusA, sessionA, statusB, sessionB] = await Promise.all([
    getBaselineStatus(db, uid),
    getOrCreateBaselineSession(db, uid),
    getBaselineStatus(db, uid),
    getOrCreateBaselineSession(db, uid),
  ]);
  const expected = [questionIds[1], questionIds[3], ...locked];
  for (const status of [statusA, statusB, sessionA.status, sessionB.status]) {
    expect(status.total).toBe(12);
    expect(status.items.filter((item) => item.isDeepen).map((item) => item.questionId)).toEqual(expected);
  }
  expect(sessionA.session.id).toBe(sessionB.session.id);
  const rows = await db.trainingSession.findMany({ where: { userId: uid, questionId: { in: expected } } });
  expect(rows).toHaveLength(4);
  expect(new Set(rows.map((row) => row.questionId)).size).toBe(4);
  expect((await getOrCreateBaselineSession(db, uid)).session.id).toBe(sessionA.session.id);
});

it("已开始的补测在更早维度评分晚到后仍从原会话恢复", async () => {
  const uid = await user();
  for (let i = 6; i < 8; i++) await score(uid, questionIds[i * 2], 20);
  for (let i = 0; i < 6; i++) await db.trainingSession.create({ data: { userId: uid, questionId: questionIds[i * 2], date: new Date(), isExtra: true, sourceType: "baseline", state: "followup", finalSubmittedAt: new Date(), finalAnswer: "已提交" } });
  const original = await getOrCreateBaselineSession(db, uid);
  expect(original.question.id).toBe(questionIds[13]);
  await db.trainingSession.update({ where: { id: original.session.id }, data: { firstAnswer: "进行中的答案", state: "answering" } });
  for (let i = 0; i < 6; i++) await score(uid, questionIds[i * 2], 20);
  const resumed = await getOrCreateBaselineSession(db, uid);
  expect(resumed.session.id).toBe(original.session.id);
  expect(resumed.session.firstAnswer).toBe("进行中的答案");
});

it("已打开阅读的补测在更早维度评分晚到后仍从原会话恢复", async () => {
  const uid = await user();
  for (let i = 6; i < 8; i++) await score(uid, questionIds[i * 2], 20);
  for (let i = 0; i < 6; i++) await db.trainingSession.create({ data: { userId: uid, questionId: questionIds[i * 2], date: new Date(), isExtra: true, sourceType: "baseline", state: "followup", finalSubmittedAt: new Date(), finalAnswer: "已提交" } });
  const original = await getOrCreateBaselineSession(db, uid);
  expect(original.question.id).toBe(questionIds[13]);
  expect(original.session.state).toBe("reading");
  for (let i = 0; i < 6; i++) await score(uid, questionIds[i * 2], 20);
  const resumed = await getOrCreateBaselineSession(db, uid);
  expect(resumed.session.id).toBe(original.session.id);
});

it("仅实际选择的补测激活，重复打开保持首次时间", async () => {
  const uid = await user();
  for (let i = 0; i < 8; i++) await score(uid, questionIds[i * 2], i < 4 ? 20 : 90);
  await getBaselineStatus(db, uid);
  const reservations = await db.trainingSession.findMany({ where: { userId: uid, questionId: { in: questionIds.filter((_, i) => i % 2 === 1) } } });
  expect(reservations).toHaveLength(4);
  expect(reservations.every((row) => row.baselineActivatedAt === null)).toBe(true);
  const first = await getOrCreateBaselineSession(db, uid);
  expect(first.session.baselineActivatedAt).not.toBeNull();
  const again = await getOrCreateBaselineSession(db, uid);
  expect(again.session.id).toBe(first.session.id);
  expect(again.session.baselineActivatedAt).toEqual(first.session.baselineActivatedAt);
  expect(await db.trainingSession.count({ where: { userId: uid, baselineActivatedAt: { not: null } } })).toBe(1);
});

it("旧数据未激活但有真实作答时优先恢复", async () => {
  const uid = await user();
  for (let i = 0; i < 8; i++) await score(uid, questionIds[i * 2], i < 4 ? 20 : 90);
  await getBaselineStatus(db, uid);
  const old = await db.trainingSession.findFirstOrThrow({ where: { userId: uid, questionId: questionIds[7] } });
  await db.trainingSession.update({ where: { id: old.id }, data: { firstAnswer: "旧答案", state: "answering" } });
  const result = await getOrCreateBaselineSession(db, uid);
  expect(result.session.id).toBe(old.id);
  expect(result.session.firstAnswer).toBe("旧答案");
});

// 历史会话由测试夹具直接构造；实际验证调用真实基线服务和数据库仓储。
it.each([
  ["B3", "B4", "问题定义"],
  ["B5", "B6", "用户理解"],
  ["B17", "B18", "产品表达"],
])("%s 已有历史进度时恢复备用题 %s 不改变原主题", async (oldId, backupId, dimension) => {
  const index = ABILITY_DIMENSIONS.indexOf(dimension as (typeof ABILITY_DIMENSIONS)[number]);
  const original = questionUuid(oldId);
  const backup = questionUuid(backupId);
  const ownPair = questionIds.slice(index * 2, index * 2 + 2);
  const createdPair: string[] = [];
  await db.question.updateMany({ where: { id: { in: ownPair } }, data: { status: "draft" } });
  try {
    for (const [id, status] of [[original, "published"], [backup, "draft"]] as const) {
      await db.question.create({ data: { id, caseTitle: `测试 ${id}`, caseBackground: {}, mainQuestion: "测试", abilityTags: [dimension], difficulty: 1, rubric: { dimensions: { [dimension]: ["测试评分点"] } }, hintTree: {}, materials: {}, status, kind: "baseline" } });
      createdQuestionIds.push(id);
      createdPair.push(id);
    }
    const highUser = await user();
    const lowUser = await user();
    const activeUser = await user();
    const completedUser = await user(new Date("2020-01-01T00:00:00Z"));
    await score(highUser, original, 90);
    for (let i = 0; i < ABILITY_DIMENSIONS.length; i++) {
      if (i !== index) await score(lowUser, questionIds[i * 2], 90);
    }
    await score(lowUser, original, 30);
    const active = await db.trainingSession.create({ data: { userId: activeUser, questionId: original, date: new Date(), isExtra: true, sourceType: "baseline", baselineActivatedAt: new Date() } });
    const before = await getBaselineStatus(db, highUser);
    expect(before.items.find((item) => item.dimension === dimension)).toMatchObject({ questionId: original, isDeepen: false });
    await db.question.update({ where: { id: backup }, data: { status: "published" } });
    const high = await getBaselineStatus(db, highUser);
    expect(high.total).toBe(8);
    expect(high.items.filter((item) => item.dimension === dimension).map((item) => [item.questionId, item.isDeepen])).toEqual([[original, false]]);
    const low = await getBaselineStatus(db, lowUser);
    expect(low.total).toBe(9);
    expect(low.items.filter((item) => item.dimension === dimension).map((item) => [item.questionId, item.isDeepen])).toEqual([[original, false], [backup, true]]);
    const reserved = await db.trainingSession.findFirstOrThrow({ where: { userId: lowUser, questionId: backup } });
    expect(reserved.baselineActivatedAt).toBeNull();
    const deepened = await getOrCreateBaselineSession(db, lowUser);
    expect(deepened.session.id).toBe(reserved.id);
    expect(deepened.session.baselineActivatedAt).not.toBeNull();
    expect((await getBaselineStatus(db, lowUser)).items.filter((item) => item.dimension === dimension).map((item) => [item.questionId, item.isDeepen])).toEqual([[original, false], [backup, true]]);
    expect((await getOrCreateBaselineSession(db, activeUser)).session.id).toBe(active.id);
    expect((await getBaselineStatus(db, completedUser)).required).toBe(false);
  } finally {
    await db.question.updateMany({ where: { id: { in: createdPair } }, data: { status: "draft" } });
    await db.question.updateMany({ where: { id: { in: ownPair } }, data: { status: "published" } });
  }
});

const legacyDeepenIndexes = [0, 4, 5, 6, 7];
const legacySubmittedAt = new Date("2026-01-02T00:00:00.000Z");

async function scoreLegacySession(sessionId: string, dimensionIndex: number, confidence: number) {
  const session = await db.trainingSession.findUniqueOrThrow({ where: { id: sessionId } });
  await db.trainingSession.update({ where: { id: sessionId }, data: { state: "scored", scoredAt: new Date(), finalSubmittedAt: session.finalSubmittedAt ?? new Date() } });
  await db.score.create({ data: { sessionId, dimension: ABILITY_DIMENSIONS[dimensionIndex], rawScore: 75, hintCount: 0, coefficient: 1, effectiveScore: 75, confidence } });
}

/** 模拟旧版晚到评分后累积五道补测的合法未完成会话，不改变已有题目。 */
async function seedLegacyOverflow(userId: string) {
  const primarySessions: string[] = [];
  const deepenSessions: string[] = [];
  for (let i = 0; i < ABILITY_DIMENSIONS.length; i++) {
    const session = await db.trainingSession.create({ data: { userId, questionId: questionIds[i * 2], date: legacySubmittedAt, isExtra: true, sourceType: "baseline", state: "followup", firstAnswer: `主题首答-${i}`, finalAnswer: `主题终答-${i}`, finalSubmittedAt: legacySubmittedAt, startedAt: new Date(legacySubmittedAt.getTime() + i * 1000) } });
    primarySessions.push(session.id);
    if (legacyDeepenIndexes.includes(i)) await scoreLegacySession(session.id, i, 20);
  }
  for (const i of legacyDeepenIndexes) {
    const pending = i === 0;
    const session = await db.trainingSession.create({ data: { userId, questionId: questionIds[i * 2 + 1], date: legacySubmittedAt, isExtra: true, sourceType: "baseline", state: pending ? "answering" : "followup", firstAnswer: `补测首答-${i}`, finalAnswer: pending ? null : `补测终答-${i}`, finalSubmittedAt: pending ? null : legacySubmittedAt, startedAt: new Date(legacySubmittedAt.getTime() + (i + 20) * 1000) } });
    deepenSessions.push(session.id);
    if (!pending) await scoreLegacySession(session.id, i, 90);
  }
  return { primarySessions, deepenSessions };
}

it("旧会话已有五道补测时保留全部答案和成绩，晚到评分不再增加题目并能完成", async () => {
  const uid = await user();
  const legacy = await seedLegacyOverflow(uid);
  const answersBefore = await db.trainingSession.findMany({ where: { userId: uid }, select: { id: true, questionId: true, firstAnswer: true, finalAnswer: true }, orderBy: { id: "asc" } });
  const scoresBefore = await db.score.findMany({ where: { session: { userId: uid } }, orderBy: { id: "asc" } });
  const expectedDeepens = legacyDeepenIndexes.map((i) => questionIds[i * 2 + 1]);
  const initial = await getBaselineStatus(db, uid);
  expect(initial).toMatchObject({ total: 13, required: true, completedAt: null });
  expect(initial.items.filter((item) => item.isDeepen).map((item) => item.questionId)).toEqual(expectedDeepens);
  const opened = await getOrCreateBaselineSession(db, uid);
  expect(opened.session.id).toBe(legacy.deepenSessions[0]);
  expect(opened.session.firstAnswer).toBe("补测首答-0");

  await scoreLegacySession(legacy.primarySessions[1], 1, 20);
  const later = await getBaselineStatus(db, uid);
  expect(later).toMatchObject({ total: 13, required: true });
  expect(later.items.filter((item) => item.isDeepen).map((item) => item.questionId)).toEqual(expectedDeepens);
  expect(await db.trainingSession.count({ where: { userId: uid } })).toBe(13);
  expect(await db.trainingSession.findFirst({ where: { userId: uid, questionId: questionIds[3] } })).toBeNull();
  expect((await getOrCreateBaselineSession(db, uid)).session.id).toBe(opened.session.id);
  expect((await getBaselineStatus(db, uid)).items).toEqual(later.items);
  expect(await db.trainingSession.findMany({ where: { userId: uid }, select: { id: true, questionId: true, firstAnswer: true, finalAnswer: true }, orderBy: { id: "asc" } })).toEqual(answersBefore);
  expect(await db.score.findMany({ where: { id: { in: scoresBefore.map((row) => row.id) } }, orderBy: { id: "asc" } })).toEqual(scoresBefore);

  for (const i of [2, 3]) await scoreLegacySession(legacy.primarySessions[i], i, 20);
  expect((await getBaselineStatus(db, uid)).total).toBe(13);
  expect(await db.trainingSession.count({ where: { userId: uid } })).toBe(13);
  await db.trainingSession.update({ where: { id: opened.session.id }, data: { finalAnswer: "补测终答-0" } });
  await scoreLegacySession(opened.session.id, 0, 90);
  const finished = await getBaselineStatus(db, uid);
  expect(finished).toMatchObject({ total: 13, doneCount: 13, required: false });
  expect(finished.completedAt).not.toBeNull();
  expect((await db.userProfile.findUniqueOrThrow({ where: { userId: uid } })).baselineCompletedAt).toEqual(finished.completedAt);
  expect((await getBaselineStatus(db, uid)).completedAt).toEqual(finished.completedAt);
  expect(await db.score.findMany({ where: { id: { in: scoresBefore.map((row) => row.id) } }, orderBy: { id: "asc" } })).toEqual(scoresBefore);
});

it("已完成的旧用户存在五道补测时仍放行且不新增会话", async () => {
  const completedAt = new Date("2020-01-01T00:00:00.000Z");
  const uid = await user(completedAt);
  await seedLegacyOverflow(uid);
  const before = await db.trainingSession.findMany({ where: { userId: uid }, select: { id: true, questionId: true, firstAnswer: true, finalAnswer: true }, orderBy: { id: "asc" } });
  const status = await getBaselineStatus(db, uid);
  expect(status).toMatchObject({ total: 13, required: false, completedAt });
  expect(status.nextQuestion).toBeNull();
  expect(await db.trainingSession.findMany({ where: { userId: uid }, select: { id: true, questionId: true, firstAnswer: true, finalAnswer: true }, orderBy: { id: "asc" } })).toEqual(before);
  expect(await db.trainingSession.count({ where: { userId: uid } })).toBe(13);
});
