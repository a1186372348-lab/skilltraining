import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";
import { GET as getHistory } from "@/app/api/history/[id]/route";
import { GET as getToday } from "@/app/api/training/today/route";
import { withUserTransaction } from "@/server/lib/user-transaction";
import { createPack, openPackItem } from "@/server/modules/packs";
import { getStageOverview, nextScoringMetadataInTransaction, startRetest } from "@/server/modules/stages";
import { getCurrentTrainingCard, getTrainingHubView } from "./hub-view";
import { abandonSession, getLatestDailySession, getOrCreateExtraSession, getOrCreateTodaySession, submitFinalAnswer } from "./service";

const db = new PrismaClient();
const users: string[] = [];
const questions: string[] = [];
const dimension = "问题定义";

async function account() {
  const row = await db.user.create({ data: {
    email: `t31-training-${randomUUID()}@example.com`, profile: { create: {
      position: "测试", yearsExperience: "1", industry: "测试", familiarProducts: [], interestAreas: [], selfAssessment: {}, baselineCompletedAt: new Date(),
    } },
  } });
  users.push(row.id);
  return row;
}

async function question(difficulty = 2) {
  const row = await db.question.create({ data: {
    caseTitle: `复测接线-${randomUUID()}`, caseBackground: {}, mainQuestion: "问题", abilityTags: [dimension],
    difficulty, rubric: { dimensions: { [dimension]: ["要点"] } }, hintTree: [], materials: {}, status: "published", kind: "daily",
  } });
  questions.push(row.id);
  return row;
}

async function pending(userId: string) {
  for (let index = 0; index < 3; index++) {
    const q = await question();
    await withUserTransaction(db, userId, async context => {
      const metadata = await nextScoringMetadataInTransaction(context, [dimension]);
      await context.tx.trainingSession.create({ data: {
        userId, questionId: q.id, date: new Date("2026-10-01"), sourceType: "daily", state: "scored", scoredAt: new Date(), ...metadata,
        scores: { create: { dimension, rawScore: 80, effectiveScore: 80, hintCount: 0, coefficient: 1 } },
      } });
    });
  }
  const result = await getStageOverview(db, userId);
  const trigger = result.dimensions.find(row => row.dimension === dimension)?.triggerId;
  if (!trigger) throw new Error("复测触发 fixture 未就绪");
  return trigger;
}

async function start(userId: string, trigger: string) {
  const result = await startRetest(db, userId, trigger);
  if (result.state !== "ready") throw new Error(`复测 fixture 未就绪：${result.state}`);
  return result.sessionId;
}

async function daily(userId: string) {
  const choose = getOrCreateTodaySession as unknown as (client: PrismaClient, id: string, options: { mode: "daily" }) => ReturnType<typeof getOrCreateTodaySession>;
  return choose(db, userId, { mode: "daily" });
}

beforeAll(async () => {
  const [row] = await db.$queryRaw<{ database: string; schema: string }[]>`SELECT current_database() AS database, current_schema() AS schema`;
  if (row.database !== "skilltraining_test" || !/^v2_core_20261103_[a-f0-9]{12}$/.test(row.schema)) throw new Error("隔离测试库身份不匹配");
});
afterEach(async () => {
  await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  await db.question.deleteMany({ where: { id: { in: questions.splice(0) } } });
});
afterAll(async () => { await db.$disconnect(); });

describe("复测与普通训练独立槽位", () => {
  it("自动推荐命中并复用复测；显式日常独立创建，历史保留来源", async () => {
    const user = await account();
    const trigger = await pending(user.id);
    for (let i = 0; i < 4; i++) await question();
    const automatic = await getOrCreateTodaySession(db, user.id);
    expect(automatic.session).toMatchObject({ sourceType: "retest", sourceId: trigger, isExtra: true });
    expect((await getOrCreateTodaySession(db, user.id)).session.id).toBe(automatic.session.id);
    const ordinary = await daily(user.id);
    expect(ordinary.session).toMatchObject({ sourceType: "daily", isExtra: false });
    expect(ordinary.session.id).not.toBe(automatic.session.id);
    expect((await daily(user.id)).session.id).toBe(ordinary.session.id);
    const history = await getTrainingHubView(db, user.id);
    expect(history.history.find(row => row.sessionId === automatic.session.id)).toMatchObject({ sourceType: "retest", sourceId: trigger });
    const detailRequest = (cookie: string) => new Request(`http://localhost/api/history/${automatic.session.id}`, { headers: { cookie } });
    const context = { params: Promise.resolve({ id: automatic.session.id }) };
    const detail = await getHistory(detailRequest(sessionCookieHeader(user)), context);
    expect(detail.status).toBe(200);
    const payload = await detail.json();
    expect(payload.data).toMatchObject({ sourceType: "retest", isExtra: true });
    expect(JSON.stringify(payload)).not.toContain("rubric");
    const stranger = await account();
    expect((await getHistory(detailRequest(sessionCookieHeader(stranger)), context)).status).toBe(404);
  });

  it("未完成普通题优先继续，计划命中优先于待复测", async () => {
    const user = await account();
    const trigger = await pending(user.id);
    await question();
    await question();
    const now = new Date();
    const day = (now.getUTCDay() + 6) % 7;
    const weekStartDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day));
    const plan = await db.trainingPlan.create({ data: { userId: user.id, weekStartDate, focusDimension: dimension, startScore: 50, targetScore: 60, reason: "测试", status: "active" } });
    const planned = await getOrCreateTodaySession(db, user.id);
    expect(planned.session).toMatchObject({ sourceType: "plan", sourceId: plan.id });
    expect(await db.retestAttempt.count({ where: { userId: user.id, triggerId: trigger } })).toBe(0);
    expect((await getOrCreateTodaySession(db, user.id)).session.id).toBe(planned.session.id);
  });

  it("已有未完成加练时自动入口继续该会话，不在锁间新开复测", async () => {
    const user = await account();
    const trigger = await pending(user.id);
    await question();
    await question();
    const extra = await getOrCreateExtraSession(db, user.id);
    expect(extra.session.sourceType).toBe("extra");
    expect((await getOrCreateTodaySession(db, user.id)).session.id).toBe(extra.session.id);
    expect(await db.retestAttempt.count({ where: { userId: user.id, triggerId: trigger } })).toBe(0);
  });

  it("复测进行时不占今日、加练、首页大厅或训练包的普通槽", async () => {
    const user = await account();
    const trigger = await pending(user.id);
    for (const difficulty of [1, 1, 2, 2, 3, 3, 4]) await question(difficulty);
    const retestId = await start(user.id, trigger);
    expect(await getLatestDailySession(db, user.id)).toBeNull();
    expect((await getCurrentTrainingCard(db, user.id)).kind).toBe("not_started");
    const extra = await getOrCreateExtraSession(db, user.id);
    expect(extra.session.sourceType).toBe("extra");
    expect(extra.session.id).not.toBe(retestId);
    await abandonSession(db, extra.session.id, user.id);
    const pack = await createPack(db, user.id, dimension);
    const opened = await openPackItem(db, user.id, pack.id, 0);
    expect(opened.sessionId).not.toBe(retestId);
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: opened.sessionId } })).sourceType).toBe("pack");
    expect(await startRetest(db, user.id, trigger)).toMatchObject({ state: "ready", sessionId: retestId });
  });

  it("复测阅读、作答或终答待评分期间均可恢复复测并独立创建普通今日题", async () => {
    for (const phase of ["reading", "answering", "pending-score"] as const) {
      const user = await account();
      const trigger = await pending(user.id);
      await question();
      await question();
      const retestId = await start(user.id, trigger);
      if (phase !== "reading") await db.trainingSession.update({ where: { id: retestId }, data: phase === "answering"
        ? { state: "answering" }
        : { state: "followup", firstAnswer: "首答", firstSubmittedAt: new Date(), finalAnswer: "终答", finalSubmittedAt: new Date() } });
      expect(await getLatestDailySession(db, user.id)).toBeNull();
      const ordinary = await daily(user.id);
      expect(ordinary.session).toMatchObject({ sourceType: "daily", isExtra: false });
      expect(ordinary.session.id).not.toBe(retestId);
      expect((await getLatestDailySession(db, user.id))?.session.id).toBe(ordinary.session.id);
      expect(await startRetest(db, user.id, trigger)).toMatchObject({ state: "ready", sessionId: retestId });
    }
  });

  it("复测未终答可终止并保留答案与触发，重开必须换未练题", async () => {
    const user = await account();
    const trigger = await pending(user.id);
    await question();
    await question();
    const sessionId = await start(user.id, trigger);
    const before = await db.trainingSession.update({ where: { id: sessionId }, data: { state: "answering", firstAnswer: "保留的答案" } });
    expect(await abandonSession(db, sessionId, user.id)).toEqual({ state: "abandoned" });
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: sessionId } })).firstAnswer).toBe("保留的答案");
    expect((await db.retestAttempt.findFirstOrThrow({ where: { originalSessionId: sessionId } })).status).toBe("abandoned");
    expect((await db.stageRecord.findUniqueOrThrow({ where: { id: trigger } })).settledAt).toBeNull();
    const next = await start(user.id, trigger);
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: next } })).questionId).not.toBe(before.questionId);
  });

  it("复测终答与终止并发只能有合法胜者", async () => {
    const user = await account();
    const trigger = await pending(user.id);
    await question();
    const sessionId = await start(user.id, trigger);
    await db.trainingSession.update({ where: { id: sessionId }, data: { state: "followup", firstAnswer: "首答", firstSubmittedAt: new Date() } });
    const results = await Promise.allSettled([submitFinalAnswer(db, sessionId, user.id, "终答"), abandonSession(db, sessionId, user.id)]);
    const session = await db.trainingSession.findUniqueOrThrow({ where: { id: sessionId } });
    const attempt = await db.retestAttempt.findFirstOrThrow({ where: { originalSessionId: sessionId } });
    if (session.state === "abandoned") {
      expect(session.finalSubmittedAt).toBeNull();
      expect(attempt.status).toBe("abandoned");
      expect(results[0].status).toBe("rejected");
    } else {
      expect(session.finalSubmittedAt).not.toBeNull();
      expect(attempt.status).toBe("active");
      expect(results[1].status).toBe("rejected");
      expect(await startRetest(db, user.id, trigger)).toMatchObject({ state: "ready", sessionId });
    }
  });

  it("单维复测会话损坏时保留待恢复事实，自动与显式日常仍可训练", async () => {
    const user = await account();
    const trigger = await pending(user.id);
    await question();
    await question();
    const sessionId = await start(user.id, trigger);
    await db.trainingSession.delete({ where: { id: sessionId } });
    const view = await getStageOverview(db, user.id);
    expect(view.dimensions.find(row => row.dimension === dimension)).toMatchObject({ status: "needs_recovery", reason: "session_missing" });
    const automatic = await getOrCreateTodaySession(db, user.id);
    expect(automatic.session.sourceType).toBe("daily");
    expect((await daily(user.id)).session.id).toBe(automatic.session.id);
    expect(await db.retestAttempt.count({ where: { userId: user.id, triggerId: trigger } })).toBe(1);
    expect((await db.stageRecord.findUniqueOrThrow({ where: { id: trigger } })).settledAt).toBeNull();
  });

  it("显式日常路由在复测进行中可用，未知 mode 快速失败", async () => {
    const user = await account();
    const trigger = await pending(user.id);
    await question();
    await question();
    const retestId = await start(user.id, trigger);
    const request = (query: string) => new Request(`http://localhost/api/training/today${query}`, { headers: { cookie: sessionCookieHeader(user) } });
    const response = await getToday(request("?mode=daily"));
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.sessionId).not.toBe(retestId);
    expect(data.sourceType).toBe("daily");
    expect((await getToday(request("?mode=unknown"))).status).toBe(400);
  });

  it("普通今日题已完成后自动入口仍推荐待复测，显式日常保留原题", async () => {
    const user = await account();
    const trigger = await pending(user.id);
    const completedQuestion = await question();
    await question();
    const now = new Date();
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const completed = await db.trainingSession.create({ data: {
      userId: user.id, questionId: completedQuestion.id, date, sourceType: "daily", isExtra: false,
      state: "scored", scoredAt: now, finalAnswer: "已完成", finalSubmittedAt: now,
      scores: { create: { dimension, rawScore: 50, effectiveScore: 50, hintCount: 0, coefficient: 1 } },
    } });
    const day = (now.getUTCDay() + 6) % 7;
    const weekStartDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day));
    await db.trainingPlan.create({ data: { userId: user.id, weekStartDate, focusDimension: dimension, startScore: 50, targetScore: 60, reason: "迟建计划", status: "active" } });
    const request = (query = "") => new Request(`http://localhost/api/training/today${query}`, { headers: { cookie: sessionCookieHeader(user) } });
    const automatic = await getToday(request());
    expect(automatic.status).toBe(200);
    expect((await automatic.json()).data).toMatchObject({ sourceType: "retest", sourceId: trigger });
    const explicit = await getToday(request("?mode=daily"));
    expect((await explicit.json()).data).toMatchObject({ sessionId: completed.id, sourceType: "daily" });
    expect(await db.trainingSession.count({ where: { userId: user.id, date, isExtra: false } })).toBe(1);
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: completed.id } })).sourceType).toBe("daily");
  });

  it("无待复测时继续显示已有完成题；普通题未终答或评分中不被复测覆盖", async () => {
    const user = await account();
    const trigger = await pending(user.id);
    await question();
    const ordinary = await daily(user.id);
    const request = () => new Request("http://localhost/api/training/today", { headers: { cookie: sessionCookieHeader(user) } });
    expect((await (await getToday(request())).json()).data.sessionId).toBe(ordinary.session.id);
    await db.trainingSession.update({ where: { id: ordinary.session.id }, data: { state: "followup", finalAnswer: "终答", finalSubmittedAt: new Date() } });
    expect((await (await getToday(request())).json()).data.sessionId).toBe(ordinary.session.id);
    expect(await db.retestAttempt.count({ where: { userId: user.id, triggerId: trigger } })).toBe(0);

    const noPendingUser = await account();
    const q = await question();
    const now = new Date();
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const done = await db.trainingSession.create({ data: {
      userId: noPendingUser.id, questionId: q.id, date, sourceType: "daily", state: "scored", scoredAt: now,
      finalAnswer: "已完成", finalSubmittedAt: now, scores: { create: { dimension, rawScore: 40, effectiveScore: 40, hintCount: 0, coefficient: 1 } },
    } });
    const response = await getToday(new Request("http://localhost/api/training/today", { headers: { cookie: sessionCookieHeader(noPendingUser) } }));
    expect((await response.json()).data.sessionId).toBe(done.id);
    expect(await db.trainingSession.count({ where: { userId: noPendingUser.id } })).toBe(1);
  });
});
