import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireScoringLease, releaseScoringLease } from "./lease";

const db = new PrismaClient();
const other = new PrismaClient();
let userId: string;
let questionId: string;

beforeAll(async () => {
  const user = await db.user.create({ data: { email: `lease-${randomUUID()}@example.com` } });
  userId = user.id;
  const question = await db.question.create({ data: { caseTitle: "lease", caseBackground: {}, mainQuestion: "?", abilityTags: [], difficulty: 1, rubric: {}, hintTree: [], materials: {} } });
  questionId = question.id;
});
afterAll(async () => {
  if (userId) await db.user.delete({ where: { id: userId } });
  if (questionId) await db.question.delete({ where: { id: questionId } });
  await Promise.all([db.$disconnect(), other.$disconnect()]);
});
async function session() {
  return db.trainingSession.create({ data: { userId, questionId, date: new Date(), state: "followup", finalAnswer: "answer", finalSubmittedAt: new Date() } });
}
describe("跨连接评分租约", () => {
  it("并发领取只有一个成功，非持有者不能释放，释放后可重试", async () => {
    const s = await session();
    const claims = await Promise.all([acquireScoringLease(db, s.id, userId), acquireScoringLease(other, s.id, userId)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const token = claims.find((value): value is string => value !== null)!;
    await releaseScoringLease(other, s.id, userId, randomUUID());
    expect(await acquireScoringLease(other, s.id, userId)).toBeNull();
    await releaseScoringLease(db, s.id, userId, token);
    expect(await acquireScoringLease(other, s.id, userId)).not.toBeNull();
  });
  it("租约过期后可恢复，旧持有者无法释放新租约", async () => {
    const s = await session();
    const old = (await acquireScoringLease(db, s.id, userId))!;
    await db.$executeRaw`UPDATE training_sessions SET scoring_lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = ${s.id}::uuid`;
    const current = await acquireScoringLease(other, s.id, userId);
    expect(current).not.toBeNull();
    await releaseScoringLease(db, s.id, userId, old);
    expect(await acquireScoringLease(db, s.id, userId)).toBeNull();
  });
  it("错误用户、无终答、非待评分状态及已有评分均不能领取", async () => {
    const s = await session();
    expect(await acquireScoringLease(db, s.id, randomUUID())).toBeNull();
    await db.trainingSession.update({ where: { id: s.id }, data: { finalAnswer: null } });
    expect(await acquireScoringLease(db, s.id, userId)).toBeNull();
    await db.trainingSession.update({ where: { id: s.id }, data: { finalAnswer: "answer", state: "scored" } });
    expect(await acquireScoringLease(db, s.id, userId)).toBeNull();
    await db.trainingSession.update({ where: { id: s.id }, data: { state: "followup" } });
    await db.score.create({ data: { sessionId: s.id, dimension: "test", rawScore: 1, hintCount: 0, coefficient: 1, effectiveScore: 1 } });
    expect(await acquireScoringLease(db, s.id, userId)).toBeNull();
  });
});
