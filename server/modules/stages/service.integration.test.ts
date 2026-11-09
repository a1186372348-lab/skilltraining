import { randomUUID } from "node:crypto";
import { PrismaClient, type TrainingSessionSource } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { withUserTransaction } from "@/server/lib/user-transaction";
import { abandonRetest, getStageOverview, nextScoringMetadataInTransaction, startRetest, syncStagesAfterScoring } from "./index";

const db = new PrismaClient();
const users: string[] = [];
const questions: string[] = [];
const dimension = "问题定义";

async function account(completed = true) {
  const row = await db.user.create({ data: {
    email: `t31-${randomUUID()}@example.com`, profile: { create: {
      position: "测试", yearsExperience: "1", industry: "测试", familiarProducts: [], interestAreas: [], selfAssessment: {},
      baselineCompletedAt: completed ? new Date() : null,
    } },
  } });
  users.push(row.id);
  return row;
}

async function question(target = dimension) {
  const row = await db.question.create({ data: {
    caseTitle: `合成题-${randomUUID()}`, caseBackground: {}, mainQuestion: "问题",
    abilityTags: [target], difficulty: 2, rubric: { dimensions: { [target]: ["合成要点"] } },
    hintTree: [], materials: {}, status: "published", kind: "daily",
  } });
  questions.push(row.id);
  return row;
}

async function scored(userId: string, questionId: string, effectiveScore: number, sourceType: TrainingSessionSource = "daily") {
  return withUserTransaction(db, userId, async context => {
    const metadata = await nextScoringMetadataInTransaction(context, [dimension]);
    return context.tx.trainingSession.create({ data: {
      userId, questionId, date: new Date("2026-11-02"), state: "scored", sourceType, scoredAt: new Date(), ...metadata,
      scores: { create: { dimension, rawScore: effectiveScore, effectiveScore, coefficient: 1, hintCount: 0 } },
    } });
  });
}

async function legacy(userId: string, questionId: string, value: number, at: Date) {
  return db.trainingSession.create({ data: {
    userId, questionId, date: new Date("2026-10-01"), state: "scored", scoredAt: at,
    scores: { create: { dimension, rawScore: value, effectiveScore: value, coefficient: 1, hintCount: 0 } },
  } });
}

async function trigger(userId: string) {
  for (let i = 0; i < 3; i++) await scored(userId, (await question()).id, 75 + i);
  const overview = await getStageOverview(db, userId);
  const row = overview.dimensions.find(item => item.dimension === dimension);
  expect(row?.triggerId).toBeTruthy();
  return row!.triggerId!;
}

async function scoreRetest(userId: string, sessionId: string, score: number) {
  return withUserTransaction(db, userId, async context => {
    const metadata = await nextScoringMetadataInTransaction(context, [dimension]);
    await context.tx.trainingSession.update({ where: { id: sessionId }, data: {
      state: "scored", finalAnswer: "合成答案", finalSubmittedAt: new Date(), scoredAt: new Date(), ...metadata,
      scores: { create: { dimension, rawScore: score, effectiveScore: score, coefficient: 1, hintCount: 0 } },
    } });
    return metadata.scoreSequence;
  });
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

describe("T31 阶段服务持久化", () => {
  it("同用户不同连接的评分序号按提交串行，回滚空号不复用", async () => {
    const user = await account();
    const firstQuestion = await question();
    const secondQuestion = await question();
    let entered!: () => void;
    let release!: () => void;
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = withUserTransaction(db, user.id, async context => {
      const metadata = await nextScoringMetadataInTransaction(context, [dimension]);
      await context.tx.trainingSession.create({ data: { userId: user.id, questionId: firstQuestion.id, date: new Date(), state: "scored", scoredAt: new Date(), ...metadata } });
      entered();
      await gate;
      return metadata.scoreSequence;
    });
    await locked;
    const second = withUserTransaction(db, user.id, async context => {
      const metadata = await nextScoringMetadataInTransaction(context, [dimension]);
      await context.tx.trainingSession.create({ data: { userId: user.id, questionId: secondQuestion.id, date: new Date(), state: "scored", scoredAt: new Date(), ...metadata } });
      return metadata.scoreSequence;
    });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(b > a).toBe(true);
    let rolledBack = BigInt(0);
    await expect(withUserTransaction(db, user.id, async context => {
      rolledBack = (await nextScoringMetadataInTransaction(context, [dimension])).scoreSequence;
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    const after = await withUserTransaction(db, user.id, context => nextScoringMetadataInTransaction(context, [dimension]));
    expect(after.scoreSequence > rolledBack && rolledBack > b).toBe(true);
    await expect(withUserTransaction(db, user.id, context => nextScoringMetadataInTransaction(context, [dimension, dimension])))
      .rejects.toMatchObject({ code: "INVALID_DIMENSION" });
  });

  it("未完成基线的旧用户只读且不创建阶段记录；已开始基线则不能看结果", async () => {
    const user = await account(false);
    for (let i = 0; i < 3; i++) await scored(user.id, (await question()).id, 80);
    const before = await getStageOverview(db, user.id);
    expect(before.baselineCompleted).toBe(false);
    expect(await db.stageProgress.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.stageRecord.count({ where: { userId: user.id } })).toBe(0);
    expect(await syncStagesAfterScoring(db, user.id)).toEqual({ status: "skipped" });
    await expect(startRetest(db, user.id, randomUUID())).rejects.toMatchObject({ code: "BASELINE_REQUIRED", httpStatus: 409 });
    const q = await question();
    await db.question.update({ where: { id: q.id }, data: { kind: "baseline" } });
    await db.trainingSession.create({ data: { userId: user.id, questionId: q.id, date: new Date(), sourceType: "baseline" } });
    await expect(getStageOverview(db, user.id)).rejects.toMatchObject({ code: "BASELINE_REQUIRED", httpStatus: 409 });
    expect(await syncStagesAfterScoring(db, user.id)).toEqual({ status: "skipped" });
  });

  it("回调丢失后恢复首个三连，即使后续已追加低分，并幂等保留一个待决", async () => {
    const user = await account();
    for (const value of [75, 76, 77, 20]) await scored(user.id, (await question()).id, value);
    const [first, again] = await Promise.all([getStageOverview(db, user.id), getStageOverview(db, user.id)]);
    expect(first.dimensions.find(row => row.dimension === dimension)?.status).toBe("suspended");
    expect(again.dimensions.find(row => row.dimension === dimension)?.triggerId).toBe(first.dimensions.find(row => row.dimension === dimension)?.triggerId);
    expect(await db.stageRecord.count({ where: { userId: user.id, dimension, type: "retest_trigger" } })).toBe(1);
  });

  it("旧窗口只固定最近三次、会话旧序号仍 NULL，后续读取不重选", async () => {
    const user = await account();
    for (let i = 0; i < 4; i++) await legacy(user.id, (await question()).id, i ? 75 : 20, new Date(Date.UTC(2026, 9, i + 1)));
    const first = await getStageOverview(db, user.id);
    expect(first.dimensions.find(row => row.dimension === dimension)?.triggerId).toBeTruthy();
    const progress = await db.stageProgress.findUniqueOrThrow({ where: { userId_dimension: { userId: user.id, dimension } } });
    expect(progress.legacyWindow).toHaveLength(3);
    await getStageOverview(db, user.id);
    expect((await db.stageProgress.findUniqueOrThrow({ where: { userId_dimension: { userId: user.id, dimension } } })).legacyWindow).toEqual(progress.legacyWindow);
    expect(await db.trainingSession.count({ where: { userId: user.id, scoreSequence: { not: null } } })).toBe(0);
  });

  it("没有触发时也固定旧窗口；已丢失的旧分不中途补位", async () => {
    const user = await account();
    const legacySessions = [];
    for (let i = 0; i < 4; i++) legacySessions.push(await legacy(user.id, (await question()).id, i < 2 ? 20 : 75, new Date(Date.UTC(2026, 9, i + 1))));
    expect((await getStageOverview(db, user.id)).dimensions.find(row => row.dimension === dimension)?.consecutive).toBe(2);
    const original = (await db.stageProgress.findUniqueOrThrow({ where: { userId_dimension: { userId: user.id, dimension } } })).legacyWindow;
    await legacy(user.id, (await question()).id, 100, new Date("2026-10-10T00:00:00Z"));
    await db.score.deleteMany({ where: { sessionId: legacySessions[2].id, dimension } });
    expect((await getStageOverview(db, user.id)).dimensions.find(row => row.dimension === dimension)?.consecutive).toBe(1);
    expect((await db.stageProgress.findUniqueOrThrow({ where: { userId_dimension: { userId: user.id, dimension } } })).legacyWindow).toEqual(original);
    expect(await db.stageRecord.count({ where: { userId: user.id, dimension, type: "retest_trigger" } })).toBe(0);
  });

  it("基线和复测成绩不参与触发；新评分快照损坏不得静默过滤", async () => {
    const user = await account();
    await scored(user.id, (await question()).id, 80);
    await scored(user.id, (await question()).id, 80, "baseline");
    await scored(user.id, (await question()).id, 80, "retest");
    const newest = await scored(user.id, (await question()).id, 80, "extra");
    expect((await getStageOverview(db, user.id)).dimensions.find(row => row.dimension === dimension)?.consecutive).toBe(2);
    await db.trainingSession.update({ where: { id: newest.id }, data: { scoredDimensions: ["伪造维度"] } });
    expect((await getStageOverview(db, user.id)).dimensions.find(row => row.dimension === dimension)).toMatchObject({ status: "needs_recovery" });
  });

  it("最后一道候选已启动后能恢复，双连接同 trigger 幂等只产生一个会话", async () => {
    const user = await account();
    const triggerId = await trigger(user.id);
    const last = await question();
    const [a, b] = await Promise.all([startRetest(db, user.id, triggerId), startRetest(db, user.id, triggerId)]);
    expect(a).toMatchObject({ state: "ready" });
    expect(b).toMatchObject({ state: "ready", sessionId: a.state === "ready" ? a.sessionId : "" });
    const view = (await getStageOverview(db, user.id)).dimensions.find(row => row.dimension === dimension);
    expect(view).toMatchObject({ status: "pending", activeSessionId: a.state === "ready" ? a.sessionId : "" });
    expect(await db.retestAttempt.count({ where: { userId: user.id, triggerId, questionId: last.id } })).toBe(1);
  });

  it("终答后继续原复测并明确评分中，不允许终止或再开题", async () => {
    const user = await account();
    const triggerId = await trigger(user.id);
    await question();
    const opened = await startRetest(db, user.id, triggerId);
    if (opened.state !== "ready") throw new Error("fixture 未启动");
    await db.trainingSession.update({ where: { id: opened.sessionId }, data: { state: "followup", finalAnswer: "合成终答", finalSubmittedAt: new Date() } });
    expect(await startRetest(db, user.id, triggerId)).toMatchObject({ state: "ready", sessionId: opened.sessionId, awaitingScore: true });
    expect((await getStageOverview(db, user.id)).dimensions.find(row => row.dimension === dimension)).toMatchObject({
      status: "pending", activeSessionId: opened.sessionId, activeSessionStatus: "awaiting_score",
    });
    await expect(abandonRetest(db, user.id, opened.sessionId)).rejects.toMatchObject({ code: "SESSION_ALREADY_SUBMITTED", httpStatus: 409 });
  });

  it("复测题必须有目标 rubric，并排除活动包预留及其他用户访问", async () => {
    const user = await account();
    const other = await account();
    const triggerId = await trigger(user.id);
    const bad = await question();
    await db.question.update({ where: { id: bad.id }, data: { rubric: { dimensions: {} } } });
    const held = await question();
    await db.trainingPack.create({ data: { userId: user.id, dimension, items: { create: {
      questionId: held.id, orderIndex: 0, targetTier: "basic", actualTier: "basic", actualDifficulty: 1, unlockedAt: new Date(),
    } } } });
    await expect(startRetest(db, other.id, triggerId)).rejects.toMatchObject({ code: "STAGE_NOT_FOUND", httpStatus: 404 });
    expect(await startRetest(db, user.id, triggerId)).toMatchObject({ state: "suspended", reason: "reserved_by_pack" });
    const free = await question();
    const started = await startRetest(db, user.id, triggerId);
    if (started.state !== "ready") throw new Error("fixture 未启动");
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: started.sessionId } })).questionId).toBe(free.id);
  });

  it("active 会话被删除时标为待恢复，不换题、不伪造结算", async () => {
    const user = await account();
    const triggerId = await trigger(user.id);
    await question();
    const opened = await startRetest(db, user.id, triggerId);
    if (opened.state !== "ready") throw new Error("fixture 未启动");
    await db.trainingSession.delete({ where: { id: opened.sessionId } });
    await question();
    expect(await startRetest(db, user.id, triggerId)).toMatchObject({ state: "needs_recovery", reason: "session_missing" });
    expect((await getStageOverview(db, user.id)).dimensions.find(row => row.dimension === dimension)?.status).toBe("needs_recovery");
    expect(await db.retestAttempt.count({ where: { userId: user.id, triggerId } })).toBe(1);
  });

  it("延迟结算使用复测评分序号 S，之后的三次高分仍触发下一轮", async () => {
    const user = await account();
    const triggerId = await trigger(user.id);
    await question();
    const opened = await startRetest(db, user.id, triggerId);
    if (opened.state !== "ready") throw new Error("fixture 未启动");
    const s = await scoreRetest(user.id, opened.sessionId, 60);
    for (let i = 0; i < 3; i++) await scored(user.id, (await question()).id, 80);
    const view = await getStageOverview(db, user.id);
    expect(view.timeline.filter(row => row.dimension === dimension && row.type === "retest_pass")).toHaveLength(1);
    expect(await db.stageRecord.count({ where: { userId: user.id, dimension, type: "retest_trigger" } })).toBe(2);
    expect((await db.stageProgress.findUniqueOrThrow({ where: { userId_dimension: { userId: user.id, dimension } } })).afterSequence).toBe(s);
    expect(await startRetest(db, user.id, triggerId)).toMatchObject({ state: "settled", outcome: "pass", sessionId: opened.sessionId });
    await db.trainingSession.delete({ where: { id: opened.sessionId } });
    expect(await startRetest(db, user.id, triggerId)).toMatchObject({ state: "settled", outcome: "pass", sessionId: null });
    await getStageOverview(db, user.id);
    expect(await db.stageRecord.count({ where: { userId: user.id, dimension, type: "retest_trigger" } })).toBe(2);
  });

  it("复测目标维出现重复评分时不结算、不展示通过或失败", async () => {
    const user = await account();
    const triggerId = await trigger(user.id);
    await question();
    const opened = await startRetest(db, user.id, triggerId);
    if (opened.state !== "ready") throw new Error("fixture 未启动");
    await scoreRetest(user.id, opened.sessionId, 80);
    await db.score.create({ data: { sessionId: opened.sessionId, dimension, rawScore: 90, effectiveScore: 90, coefficient: 1, hintCount: 0 } });
    const result = await getStageOverview(db, user.id);
    expect(result.dimensions.find(row => row.dimension === dimension)).toMatchObject({ status: "needs_recovery", reason: "invalid_score" });
    expect(result.timeline.some(row => row.type === "retest_pass" || row.type === "retest_fail")).toBe(false);
  });

  it("未关闭的 trigger 已存在结算事件时标记异常，不再创建新会话", async () => {
    const user = await account();
    const triggerId = await trigger(user.id);
    await question();
    await db.stageRecord.create({ data: {
      userId: user.id, dimension, type: "retest_pass", triggerId, eventScoreSequence: BigInt(100),
      resultOriginalSessionId: randomUUID(), resultEffectiveScore: 80,
    } });
    expect((await getStageOverview(db, user.id)).dimensions.find(row => row.dimension === dimension)).toMatchObject({ status: "needs_recovery", reason: "inconsistent" });
    expect(await startRetest(db, user.id, triggerId)).toMatchObject({ state: "needs_recovery", reason: "inconsistent" });
    expect(await db.retestAttempt.count({ where: { userId: user.id, triggerId } })).toBe(0);
  });

  it("未评分复测的目标维 rubric 被覆盖后标记待恢复，不新建或误结算", async () => {
    const user = await account();
    const triggerId = await trigger(user.id);
    const candidate = await question();
    const opened = await startRetest(db, user.id, triggerId);
    if (opened.state !== "ready") throw new Error("fixture 未启动");
    await db.question.update({ where: { id: candidate.id }, data: { status: "archived" } });
    expect(await startRetest(db, user.id, triggerId)).toMatchObject({ state: "ready", sessionId: opened.sessionId });
    await db.question.update({ where: { id: candidate.id }, data: { rubric: { dimensions: {} } } });
    expect(await startRetest(db, user.id, triggerId)).toMatchObject({ state: "needs_recovery", reason: "inconsistent" });
    expect((await getStageOverview(db, user.id)).dimensions.find(row => row.dimension === dimension)).toMatchObject({ status: "needs_recovery" });
    expect(await db.retestAttempt.count({ where: { userId: user.id, triggerId } })).toBe(1);
  });

  it("终止保留原答案和 trigger，排除原题；题库无候选时挂起并可补题恢复", async () => {
    const user = await account();
    const triggerId = await trigger(user.id);
    const firstQuestion = await question();
    const opened = await startRetest(db, user.id, triggerId);
    if (opened.state !== "ready") throw new Error("fixture 未启动");
    await db.trainingSession.update({ where: { id: opened.sessionId }, data: { firstAnswer: "保留答案" } });
    await abandonRetest(db, user.id, opened.sessionId);
    expect(await db.trainingSession.findUniqueOrThrow({ where: { id: opened.sessionId } })).toMatchObject({ state: "abandoned", firstAnswer: "保留答案" });
    expect(await startRetest(db, user.id, triggerId)).toMatchObject({ state: "suspended", reason: "no_candidate" });
    const next = await question();
    const resumed = await startRetest(db, user.id, triggerId);
    if (resumed.state !== "ready") throw new Error("fixture 未恢复");
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: resumed.sessionId } })).questionId).toBe(next.id);
    expect(next.id).not.toBe(firstQuestion.id);
  });
});
