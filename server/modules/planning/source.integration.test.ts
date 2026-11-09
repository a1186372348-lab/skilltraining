import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { backfillSessionSource } from "@/scripts/lib/backfill-session-source";

const db = new PrismaClient();
let userId: string;
const questionIds: string[] = [];
beforeAll(async () => {
  userId = (await db.user.create({ data: { email: `t29-source-${randomUUID()}@example.com` } })).id;
});
afterAll(async () => {
  await db.user.deleteMany({ where: { id: userId } });
  await db.question.deleteMany({ where: { id: { in: questionIds } } });
  await db.$disconnect();
});
it("只回填明确历史范围，保留新来源、来源对象及训练有效分", async () => {
  for (const kind of ["daily", "baseline"] as const) {
    const q = await db.question.create({ data: { kind, caseTitle: "合成题", caseBackground: {}, mainQuestion: "问题", abilityTags: [], difficulty: 1, rubric: {}, hintTree: [], materials: {} } });
    questionIds.push(q.id);
  }
  const startedAt = new Date("2026-10-19T10:00:00Z");
  for (const [questionId, isExtra] of [[questionIds[0], false], [questionIds[0], true], [questionIds[1], true]] as const) {
    await db.trainingSession.create({ data: { userId, questionId, isExtra, startedAt, date: new Date("2026-10-19"), sourceType: "daily", scoredAt: new Date("2026-10-19T12:00:00Z"), scores: { create: { dimension: "问题定义", rawScore: 80, hintCount: 0, coefficient: 1, effectiveScore: 80 } } } });
  }
  for (const sourceType of ["plan", "pack", "retest"] as const) {
    await db.trainingSession.create({ data: { userId, questionId: questionIds[0], isExtra: true, startedAt, date: new Date("2026-10-19"), sourceType } });
  }
  await db.trainingSession.create({ data: { userId, questionId: questionIds[0], isExtra: true, startedAt, date: new Date("2026-10-19"), sourceType: "daily", sourceId: randomUUID() } });
  const before = await db.trainingSession.findMany({ where: { userId }, include: { scores: true, question: { select: { kind: true } } }, orderBy: { id: "asc" } });
  const scope = { userId, sessionIds: before.map(row => row.id), before: new Date("2026-10-22T14:00:00Z") };
  expect((await backfillSessionSource(db, scope)).updated).toBe(2);
  expect((await backfillSessionSource(db, scope)).updated).toBe(0);
  const after = await db.trainingSession.findMany({ where: { userId }, include: { scores: true, question: { select: { kind: true } } }, orderBy: { id: "asc" } });
  expect(after.map((s) => s.sourceType).sort()).toEqual(["baseline", "daily", "daily", "extra", "pack", "plan", "retest"]);
  const protectedBefore = before.filter(row => ["plan", "pack", "retest"].includes(row.sourceType) || row.sourceId !== null);
  for (const row of protectedBefore) expect(after.find(item => item.id === row.id)?.sourceType).toBe(row.sourceType);
  const facts = (rows: typeof before) => rows.map((row) => ({ id: row.id, date: row.date, isExtra: row.isExtra, scoredAt: row.scoredAt, sourceId: row.sourceId, question: row.question, scores: row.scores }));
  expect(facts(after)).toEqual(facts(before));
});
