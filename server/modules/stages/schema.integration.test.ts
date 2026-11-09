import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const db = new PrismaClient();
const users: string[] = [];
const questions: string[] = [];
const dimension = "问题定义";

async function setup() {
  const user = await db.user.create({ data: { email: `t31-schema-${randomUUID()}@example.com` } });
  users.push(user.id);
  const question = await db.question.create({ data: {
    caseTitle: "合成约束题", caseBackground: {}, mainQuestion: "问题", abilityTags: [dimension],
    difficulty: 1, rubric: {}, hintTree: [], materials: {}, status: "published", kind: "daily",
  } });
  questions.push(question.id);
  return { user, question };
}

function evidence() {
  return Array.from({ length: 3 }, (_, index) => ({ sessionId: randomUUID(), scoredAt: new Date().toISOString(), sequence: String(index + 1), effectiveScore: 75 }));
}

async function trigger(userId: string) {
  return db.stageRecord.create({ data: { userId, dimension, type: "retest_trigger", qualifying: evidence(), eventScoreSequence: BigInt(3) } });
}

beforeAll(async () => {
  const [row] = await db.$queryRaw<{ database: string; schema: string }[]>`SELECT current_database() AS database, current_schema() AS schema`;
  if (row.database !== "skilltraining_test" || !/^v2_core_20261103_[a-f0-9]{12}$/.test(row.schema)) throw new Error("隔离测试库身份不匹配");
});
afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.question.deleteMany({ where: { id: { in: questions } } });
  await db.$disconnect();
});

describe("T31 数据库约束", () => {
  it("序列 CACHE 1、部分索引和可延迟外键实际存在", async () => {
    const seq = await db.$queryRaw<{ cache_size: bigint; cycle: boolean }[]>`
      SELECT cache_size, cycle FROM pg_sequences WHERE schemaname = current_schema() AND sequencename = 'training_session_score_sequence'
    `;
    expect(seq).toEqual([{ cache_size: BigInt(1), cycle: false }]);
    const indexes = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname IN ('stage_records_one_pending_per_dimension_idx', 'retest_attempts_one_active_per_trigger_idx')
    `;
    expect(indexes).toHaveLength(2);
    expect(indexes.every(row => /UNIQUE INDEX.*WHERE/.test(row.indexdef))).toBe(true);
    const fks = await db.$queryRaw<{ name: string; deferred: boolean }[]>`
      SELECT conname AS name, (condeferrable AND condeferred) AS deferred FROM pg_constraint
      WHERE connamespace = current_schema()::regnamespace AND conname IN ('stage_records_trigger_id_user_id_dimension_fkey', 'retest_attempts_trigger_id_user_id_dimension_fkey')
    `;
    expect(fks).toHaveLength(2);
    expect(fks.every(row => row.deferred)).toBe(true);
  });

  it("直接并发写入仍每维只有一个 trigger，pass/fail 对同 trigger 只能成功一次", async () => {
    const { user } = await setup();
    const created = await Promise.allSettled([trigger(user.id), trigger(user.id)]);
    expect(created.filter(row => row.status === "fulfilled")).toHaveLength(1);
    const saved = await db.stageRecord.findFirstOrThrow({ where: { userId: user.id, dimension, type: "retest_trigger" } });
    const result = (type: "retest_pass" | "retest_fail", value: number) => db.stageRecord.create({ data: {
      userId: user.id, dimension, type, triggerId: saved.id, resultOriginalSessionId: randomUUID(), resultEffectiveScore: value, eventScoreSequence: BigInt(4),
    } });
    const outcomes = await Promise.allSettled([result("retest_pass", 60), result("retest_fail", 59)]);
    expect(outcomes.filter(row => row.status === "fulfilled")).toHaveLength(1);
  });

  it("会话元数据、事件形态及复测结算分数受 CHECK 保护", async () => {
    const { user, question } = await setup();
    await expect(db.trainingSession.create({ data: {
      userId: user.id, questionId: question.id, date: new Date(), state: "reading", scoreSequence: BigInt(1), scoredDimensions: [dimension],
    } })).rejects.toThrow();
    const pending = await trigger(user.id);
    await expect(db.stageRecord.create({ data: {
      userId: user.id, dimension, type: "retest_pass", triggerId: pending.id, eventScoreSequence: BigInt(4),
      resultOriginalSessionId: randomUUID(), resultEffectiveScore: 59.99,
    } })).rejects.toThrow();
    await expect(db.stageRecord.create({ data: { userId: user.id, dimension: "用户理解", type: "retest_trigger", qualifying: [], eventScoreSequence: BigInt(0) } })).rejects.toThrow();
  });

  it("删会话保留尝试原身份，删 trigger 被保护，删除用户完整级联", async () => {
    const { user, question } = await setup();
    const record = await trigger(user.id);
    const session = await db.trainingSession.create({ data: {
      userId: user.id, questionId: question.id, date: new Date(), sourceType: "retest", sourceId: record.id, isExtra: true,
    } });
    const attempt = await db.retestAttempt.create({ data: {
      userId: user.id, triggerId: record.id, dimension, questionId: question.id, sessionId: session.id, originalSessionId: session.id,
    } });
    await db.trainingSession.delete({ where: { id: session.id } });
    expect(await db.retestAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ sessionId: null, originalSessionId: session.id });
    let inside = false;
    await expect(db.$transaction(async tx => { await tx.stageRecord.delete({ where: { id: record.id } }); inside = true; })).rejects.toThrow();
    expect(inside).toBe(true);
    await expect(db.user.delete({ where: { id: user.id } })).resolves.toBeDefined();
    expect(await db.retestAttempt.findUnique({ where: { id: attempt.id } })).toBeNull();
    expect(await db.stageRecord.findUnique({ where: { id: record.id } })).toBeNull();
  });
});
