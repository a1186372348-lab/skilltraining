import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";
import { GET } from "@/app/api/training/hub/route";
import { todayUtc } from "./service";

const db = new PrismaClient();
const userIds: string[] = [];
const questionIds: string[] = [];

beforeAll(async () => {
  const [row] = await db.$queryRaw<{ database: string; schema: string }[]>`SELECT current_database() AS database, current_schema() AS schema`;
  if (row.database !== "skilltraining_test" || !/^v2_core_20261103_[a-f0-9]{12}$/.test(row.schema)) throw new Error("测试库隔离不匹配");
});
afterEach(async () => {
  await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  await db.question.deleteMany({ where: { id: { in: questionIds.splice(0) } } });
});
afterAll(async () => { await db.$disconnect(); });

it("大厅仅返回本人包来源编号，基线维持空值且不暴露其他用户记录", async () => {
  const owner = await db.user.create({ data: {
    email: `t30-hub-${randomUUID()}@example.com`, profile: { create: {
      position: "测试", yearsExperience: "1", industry: "测试", familiarProducts: [], interestAreas: [],
      selfAssessment: {}, baselineCompletedAt: new Date(),
    } },
  } });
  const stranger = await db.user.create({ data: { email: `t30-hub-${randomUUID()}@example.com` } });
  userIds.push(owner.id, stranger.id);
  const makeQuestion = async (kind: "daily" | "baseline") => {
    const q = await db.question.create({ data: {
      kind, caseTitle: "大厅隔离测试", caseBackground: {}, mainQuestion: "问题", abilityTags: [],
      difficulty: 1, rubric: { private: "rubric-secret" }, hintTree: [], materials: {}, status: "draft",
    } });
    questionIds.push(q.id);
    return q;
  };
  const [daily, baseline] = await Promise.all([makeQuestion("daily"), makeQuestion("baseline")]);
  const ownPackId = randomUUID();
  const strangerPackId = randomUUID();
  const ownSession = await db.trainingSession.create({ data: {
    userId: owner.id, questionId: daily.id, date: todayUtc(), isExtra: true,
    sourceType: "pack", sourceId: ownPackId, state: "scored", finalSubmittedAt: new Date(),
  } });
  const baselineSession = await db.trainingSession.create({ data: {
    userId: owner.id, questionId: baseline.id, date: todayUtc(), isExtra: true,
    sourceType: "baseline", state: "scored", baselineActivatedAt: new Date(),
  } });
  const otherSession = await db.trainingSession.create({ data: {
    userId: stranger.id, questionId: daily.id, date: todayUtc(), isExtra: true,
    sourceType: "pack", sourceId: strangerPackId, state: "scored", finalSubmittedAt: new Date(),
  } });
  const anonymous = await GET(new Request("http://localhost/api/training/hub"));
  expect(anonymous.status).toBe(401);
  const response = await GET(new Request("http://localhost/api/training/hub", { headers: { cookie: sessionCookieHeader(owner) } }));
  expect(response.status).toBe(200);
  const json = await response.json();
  expect(json.data.history.find((item: { sessionId: string }) => item.sessionId === ownSession.id))
    .toMatchObject({ sourceType: "pack", sourceId: ownPackId, isBaseline: false });
  expect(json.data.history.find((item: { sessionId: string }) => item.sessionId === baselineSession.id))
    .toMatchObject({ sourceType: "baseline", sourceId: null, isBaseline: true });
  expect(JSON.stringify(json)).not.toContain(otherSession.id);
  expect(JSON.stringify(json)).not.toContain(strangerPackId);
  expect(JSON.stringify(json)).not.toContain("rubric-secret");
});
