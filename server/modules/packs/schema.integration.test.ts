import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const db = new PrismaClient();
const users: string[] = [];
const questions: string[] = [];

async function user() {
  const row = await db.user.create({ data: { email: `t30-schema-${randomUUID()}@example.com` } });
  users.push(row.id);
  return row;
}

async function question() {
  const row = await db.question.create({ data: {
    caseTitle: "合成约束题", caseBackground: {}, mainQuestion: "题目", abilityTags: ["问题定义"],
    difficulty: 1, rubric: {}, hintTree: [], materials: {}, status: "published", kind: "daily",
  } });
  questions.push(row.id);
  return row;
}

async function bundle(userId: string) {
  const q = await question();
  const plan = await db.trainingPlan.create({ data: {
    userId, weekStartDate: new Date("2026-11-02T00:00:00Z"), focusDimension: "问题定义",
    startScore: 50, targetScore: 60, reason: "合成计划",
  } });
  const pack = await db.trainingPack.create({ data: { userId, dimension: "问题定义" } });
  const session = await db.trainingSession.create({ data: {
    userId, questionId: q.id, date: new Date("2026-11-03"), isExtra: true, sourceType: "pack", sourceId: pack.id,
    linkedPlanId: plan.id, scores: { create: { dimension: "问题定义", rawScore: 70, hintCount: 0, coefficient: 1, effectiveScore: 70 } },
  } });
  const item = await db.packItem.create({ data: {
    packId: pack.id, questionId: q.id, orderIndex: 0, targetTier: "basic", actualTier: "basic", actualDifficulty: 1,
    unlockedAt: new Date(), startedAt: new Date(), sessionId: session.id,
  } });
  return { q, plan, pack, session, item };
}

beforeAll(async () => {
  const [row] = await db.$queryRaw<{ database: string; schema: string }[]>`SELECT current_database() AS database, current_schema() AS schema`;
  if (row.database !== "skilltraining_test" || !/^v2_core_20261103_[a-f0-9]+$/.test(row.schema)) throw new Error("测试数据库或隔离 schema 不匹配");
});
afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.question.deleteMany({ where: { id: { in: questions } } });
  await db.$disconnect();
});

describe("训练包数据库约束", () => {
  it("实际索引和延迟外键存在且属性正确", async () => {
    const indexes = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'training_packs_one_active_per_user_idx'
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexdef).toMatch(/UNIQUE INDEX/);
    expect(indexes[0].indexdef).toMatch(/WHERE.*active/);
    const constraints = await db.$queryRaw<{ deferrable: boolean; deferred: boolean; delete_action: string }[]>`
      SELECT condeferrable AS deferrable, condeferred AS deferred, confdeltype::text AS delete_action
      FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND conname = 'training_sessions_linked_plan_id_fkey'
    `;
    expect(constraints).toEqual([{ deferrable: true, deferred: true, delete_action: "a" }]);
  });

  it("脱离服务并发写入时，每用户依然只能存在一个活动包", async () => {
    const account = await user();
    const other = await user();
    const create = () => db.trainingPack.create({ data: { userId: account.id, dimension: "问题定义" } });
    const result = await Promise.allSettled([create(), create()]);
    expect(result.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(result.filter(value => value.status === "rejected")).toHaveLength(1);
    expect(await db.trainingPack.count({ where: { userId: account.id, status: "active" } })).toBe(1);
    await expect(db.trainingPack.create({ data: { userId: other.id, dimension: "问题定义" } })).resolves.toBeDefined();
    await expect(db.trainingPack.create({ data: { userId: account.id, dimension: "问题定义", status: "completed", endedAt: new Date() } })).resolves.toBeDefined();
  });

  it("顺序、难度快照、会话和解锁标记均由数据库拒绝非法组合", async () => {
    const account = await user();
    const { pack, q, item } = await bundle(account.id);
    await expect(db.packItem.update({ where: { id: item.id }, data: { orderIndex: 5 } })).rejects.toThrow();
    await expect(db.packItem.update({ where: { id: item.id }, data: { actualDifficulty: 5, actualTier: "basic" } })).rejects.toThrow();
    await expect(db.packItem.update({ where: { id: item.id }, data: { startedAt: null } })).rejects.toThrow();
    await expect(db.packItem.update({ where: { id: item.id }, data: { unlockedAt: null } })).rejects.toThrow();
    await expect(db.packItem.create({ data: { packId: pack.id, questionId: q.id, orderIndex: 1, targetTier: "basic", actualTier: "basic", actualDifficulty: 1 } })).rejects.toThrow();
    await expect(db.trainingPack.update({ where: { id: pack.id }, data: { status: "completed" } })).rejects.toThrow();
  });

  it("删除包只删条目，会话与评分保留；删除会话清空条目关联但保留开题标记", async () => {
    const account = await user();
    const first = await bundle(account.id);
    await db.trainingPack.delete({ where: { id: first.pack.id } });
    expect(await db.packItem.findUnique({ where: { id: first.item.id } })).toBeNull();
    expect(await db.trainingSession.findUnique({ where: { id: first.session.id } })).not.toBeNull();
    expect(await db.score.count({ where: { sessionId: first.session.id } })).toBe(1);
    const pack = await db.trainingPack.create({ data: { userId: account.id, dimension: "问题定义" } });
    const item = await db.packItem.create({ data: {
      packId: pack.id, questionId: first.q.id, orderIndex: 0, targetTier: "basic", actualTier: "basic", actualDifficulty: 1,
      unlockedAt: new Date(), startedAt: first.item.startedAt, sessionId: first.session.id,
    } });
    await db.trainingSession.delete({ where: { id: first.session.id } });
    expect(await db.packItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ sessionId: null, startedAt: first.item.startedAt });
    expect(await db.score.count({ where: { sessionId: first.session.id } })).toBe(0);
  });

  it("计划仍被会话引用时提交删除失败，删除用户则完整级联", async () => {
    const account = await user();
    const { plan, session, pack } = await bundle(account.id);
    let reachedAfterDelete = false;
    await expect(db.$transaction(async tx => {
      await tx.trainingPlan.delete({ where: { id: plan.id } });
      reachedAfterDelete = true;
    })).rejects.toThrow();
    expect(reachedAfterDelete).toBe(true);
    expect(await db.trainingPlan.findUnique({ where: { id: plan.id } })).not.toBeNull();
    await expect(db.user.delete({ where: { id: account.id } })).resolves.toBeDefined();
    expect(await db.trainingPlan.findUnique({ where: { id: plan.id } })).toBeNull();
    expect(await db.trainingSession.findUnique({ where: { id: session.id } })).toBeNull();
    expect(await db.trainingPack.findUnique({ where: { id: pack.id } })).toBeNull();
  });
});
