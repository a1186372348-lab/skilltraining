import { randomUUID } from "node:crypto";
import { PrismaClient, type TrainingSessionSource } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { getStageOverview, startRetest } from "@/server/modules/stages";
import { scoreSession } from "./service";
import type { RubricScoringInput, RubricScoringOutput } from "./rubric-scorer";

const db = new PrismaClient();
const otherConnection = new PrismaClient();
const users: string[] = [];
const questions: string[] = [];
const dimension = "问题定义";

async function account(completed = true) {
  const row = await db.user.create({ data: {
    email: `t31-score-${randomUUID()}@example.com`, profile: { create: {
      position: "测试", yearsExperience: "1", industry: "测试", familiarProducts: [], interestAreas: [], selfAssessment: {},
      baselineCompletedAt: completed ? new Date() : null,
    } },
  } });
  users.push(row.id);
  return row;
}

async function question(kind: "daily" | "baseline" = "daily") {
  const row = await db.question.create({ data: {
    kind, caseTitle: `评分接线-${randomUUID()}`, caseBackground: {}, mainQuestion: "问题", abilityTags: [dimension],
    difficulty: 2, rubric: { dimensions: { [dimension]: ["要点"] } }, hintTree: [], materials: {}, status: "published",
  } });
  questions.push(row.id);
  return row;
}

async function scorable(userId: string, sourceType: TrainingSessionSource = "daily") {
  const q = await question(sourceType === "baseline" ? "baseline" : "daily");
  const trigger = sourceType === "retest" ? await db.stageRecord.create({ data: {
    userId, dimension, type: "retest_trigger", eventScoreSequence: BigInt(0),
    qualifying: [0, 1, 2].map(() => ({ sessionId: randomUUID(), scoredAt: new Date().toISOString(), sequence: null, effectiveScore: 80 })),
  } }) : null;
  const session = await db.trainingSession.create({ data: {
    userId, questionId: q.id, date: new Date("2026-11-03"), sourceType,
    sourceId: trigger?.id ?? (sourceType === "pack" ? randomUUID() : null),
    state: "followup", firstAnswer: "首答", firstSubmittedAt: new Date(), finalAnswer: "终答", finalSubmittedAt: new Date(),
  } });
  if (trigger) await db.retestAttempt.create({ data: {
    userId, triggerId: trigger.id, dimension, questionId: q.id, sessionId: session.id, originalSessionId: session.id,
  } });
  return session;
}

function score(value: number) {
  return async (input: RubricScoringInput): Promise<RubricScoringOutput> => ({
    dimensions: Object.keys(input.rubricDimensions).map(name => ({ dimension: name, rawScore: value, diagnosis: "合成诊断" })),
    topIssue: "合成问题", nextFocus: "合成建议", confidence: null,
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
afterAll(async () => { await db.$disconnect(); await otherConnection.$disconnect(); });

describe("评分写入与阶段恢复接线", () => {
  it("普通、基线及复测新评分均原子保存序号和本次维度；旧结果重试不补号", async () => {
    const user = await account(false);
    const observed: bigint[] = [];
    for (const sourceType of ["daily", "baseline", "retest"] as const) {
      const session = await scorable(user.id, sourceType);
      const result = await scoreSession(db, session.id, user.id, { scoreWithRubric: score(70) });
      expect(() => JSON.stringify(result)).not.toThrow();
      const saved = await db.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(saved.scoreSequence).not.toBeNull();
      expect(saved.scoreSequence! > BigInt(0)).toBe(true);
      expect(saved.scoredDimensions).toEqual([dimension]);
      expect(saved.state).toBe("scored");
      expect(saved.scoredAt).not.toBeNull();
      observed.push(saved.scoreSequence!);
      await scoreSession(db, session.id, user.id, { scoreWithRubric: vi.fn() });
      expect((await db.trainingSession.findUniqueOrThrow({ where: { id: session.id } })).scoreSequence).toBe(saved.scoreSequence);
    }
    expect(observed[0] < observed[1] && observed[1] < observed[2]).toBe(true);
    const legacy = await scorable(user.id);
    await db.trainingSession.update({ where: { id: legacy.id }, data: {
      state: "scored", scoredAt: new Date(), scores: { create: { dimension, rawScore: 60, effectiveScore: 60, hintCount: 0, coefficient: 1 } },
    } });
    await scoreSession(db, legacy.id, user.id, { scoreWithRubric: vi.fn() });
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: legacy.id } })).scoreSequence).toBeNull();
  });

  it("同用户不同连接：慢模型先开始、快模型先提交时，序号按提交顺序而非开始顺序", async () => {
    const user = await account(false);
    const slowSession = await scorable(user.id);
    const fastSession = await scorable(user.id);
    let release!: () => void;
    let started!: () => void;
    const slowStarted = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const begin = Date.now();
    const slow = scoreSession(db, slowSession.id, user.id, { scoreWithRubric: async input => { started(); await gate; return score(80)(input); } });
    await slowStarted;
    try {
      await scoreSession(otherConnection, fastSession.id, user.id, { scoreWithRubric: score(80) });
    } finally { release(); }
    await slow;
    const [first, second] = await Promise.all([
      db.trainingSession.findUniqueOrThrow({ where: { id: fastSession.id } }),
      db.trainingSession.findUniqueOrThrow({ where: { id: slowSession.id } }),
    ]);
    expect(first.scoreSequence).not.toBeNull();
    expect(second.scoreSequence).not.toBeNull();
    expect(first.scoreSequence! < second.scoreSequence!).toBe(true);
    expect(first.scoredAt!.getTime()).toBeGreaterThanOrEqual(begin);
    expect(second.scoredAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("评分写事务回滚可留下空号，不能留下半截评分", async () => {
    const user = await account(false);
    const before = await scorable(user.id);
    await scoreSession(db, before.id, user.id, { scoreWithRubric: score(70) });
    const failed = await scorable(user.id);
    await db.sessionFeedback.create({ data: { sessionId: failed.id, topIssueText: "占位", nextFocusText: "占位" } });
    await expect(scoreSession(db, failed.id, user.id, { scoreWithRubric: score(70) })).rejects.toThrow();
    expect(await db.score.count({ where: { sessionId: failed.id } })).toBe(0);
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: failed.id } })).scoreSequence).toBeNull();
    const after = await scorable(user.id);
    await scoreSession(db, after.id, user.id, { scoreWithRubric: score(70) });
    const a = await db.trainingSession.findUniqueOrThrow({ where: { id: before.id } });
    const b = await db.trainingSession.findUniqueOrThrow({ where: { id: after.id } });
    expect(b.scoreSequence! > a.scoreSequence! + BigInt(1)).toBe(true);
  });

  it("并发评分落败者复用已提交序号并独立补偿阶段", async () => {
    const user = await account(false);
    const session = await scorable(user.id);
    const afterStagesScored = vi.fn(async () => {});
    let committed: bigint | null = null;
    const result = await scoreSession(db, session.id, user.id, {
      scoreWithRubric: async input => {
        await scoreSession(otherConnection, session.id, user.id, { scoreWithRubric: score(75) });
        committed = (await db.trainingSession.findUniqueOrThrow({ where: { id: session.id } })).scoreSequence;
        return score(90)(input);
      },
      afterStagesScored,
    });
    expect(result.scores[0].rawScore).toBe(75);
    expect(committed).not.toBeNull();
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: session.id } })).scoreSequence).toBe(committed);
    expect(await db.score.count({ where: { sessionId: session.id } })).toBe(1);
    expect(afterStagesScored).toHaveBeenCalledOnce();
  });

  it("复测已评分后题目被改写，幂等回读仍使用既有评分并尝试恢复", async () => {
    const user = await account(false);
    const session = await scorable(user.id, "retest");
    await scoreSession(db, session.id, user.id, { scoreWithRubric: score(70) });
    const saved = await db.trainingSession.findUniqueOrThrow({ where: { id: session.id } });
    await db.question.update({ where: { id: session.questionId }, data: { abilityTags: [], rubric: { dimensions: {} } } });
    const afterStagesScored = vi.fn(async () => {});
    const repeated = await scoreSession(db, session.id, user.id, { scoreWithRubric: vi.fn(), afterStagesScored });
    expect(repeated.scores[0].effectiveScore).toBe(70);
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: session.id } })).scoreSequence).toBe(saved.scoreSequence);
    expect(afterStagesScored).toHaveBeenCalledOnce();
  });

  it("复测题被覆盖导致目标维不在实际评分标准时不调用模型、不写分", async () => {
    const user = await account(false);
    const session = await scorable(user.id, "retest");
    await db.question.update({ where: { id: session.questionId }, data: {
      abilityTags: ["用户理解"], rubric: { dimensions: { 用户理解: ["新标准"] } },
    } });
    const scorer = vi.fn(score(80));
    await expect(scoreSession(db, session.id, user.id, { scoreWithRubric: scorer }))
      .rejects.toMatchObject({ code: "QUESTION_RUBRIC_INVALID", httpStatus: 409 });
    expect(scorer).not.toHaveBeenCalled();
    expect(await db.score.count({ where: { sessionId: session.id } })).toBe(0);
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: session.id } })).state).toBe("followup");
  });

  it("回调失败后的复测以自身序号 S 结算，S 后三次高分仍触发下一轮", async () => {
    const user = await account();
    const failedHook = vi.fn(async () => { throw new Error("private-stage-detail"); });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const value of [75, 75, 75, 20]) {
        const session = await scorable(user.id);
        await scoreSession(db, session.id, user.id, { scoreWithRubric: score(value), afterStagesScored: failedHook } as never);
      }
      await question();
      const initial = await getStageOverview(db, user.id);
      const trigger = initial.dimensions.find(row => row.dimension === dimension)?.triggerId;
      expect(trigger).toBeTruthy();
      const retest = await startRetest(db, user.id, trigger!);
      if (retest.state !== "ready") throw new Error("复测测试数据未就绪");
      await db.trainingSession.update({ where: { id: retest.sessionId }, data: {
        state: "followup", firstAnswer: "首答", firstSubmittedAt: new Date(), finalAnswer: "终答", finalSubmittedAt: new Date(),
      } });
      await scoreSession(db, retest.sessionId, user.id, { scoreWithRubric: score(60), afterStagesScored: failedHook } as never);
      const sequence = (await db.trainingSession.findUniqueOrThrow({ where: { id: retest.sessionId } })).scoreSequence;
      for (let i = 0; i < 3; i++) {
        const session = await scorable(user.id);
        await scoreSession(otherConnection, session.id, user.id, { scoreWithRubric: score(80), afterStagesScored: failedHook } as never);
      }
      expect(failedHook).toHaveBeenCalled();
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private-stage-detail");
      const recovered = await getStageOverview(db, user.id);
      expect(recovered.timeline.filter(row => row.dimension === dimension && row.type === "retest_pass")).toHaveLength(1);
      expect(await db.stageRecord.count({ where: { userId: user.id, dimension, type: "retest_trigger" } })).toBe(2);
      expect((await db.stageProgress.findUniqueOrThrow({ where: { userId_dimension: { userId: user.id, dimension } } })).afterSequence).toBe(sequence);
    } finally { warning.mockRestore(); }
  });
});
