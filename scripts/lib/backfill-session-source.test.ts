import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { backfillSessionSource } from "./backfill-session-source";

// TrainingSession sourceType/sourceId 历史回填集成测试（T29 切片 1）：
// 真实测试库（vitest.setup 强制 skilltraining_test，pretest 已 migrate deploy 新列）。
// 构造三类历史会话并把 source_type 重置为迁移前默认值 daily，验证回填映射与幂等；
// 回填只写新列，绝不修改 isExtra / question.kind 等既有事实列（任务契约「数据保护」）。

const prisma = new PrismaClient();
const SUFFIX = Date.now().toString(36);
let userId: string;
let dailyQuestionId: string;
let baselineQuestionId: string;
let historicalSessionIds: string[];
const historicalCutoff = new Date("2026-10-22T14:00:00.000Z");

/** 最小题目行（仅需回填判定相关字段 + 契约必填字段） */
function questionData(id: string, kind: "daily" | "baseline") {
  return {
    id,
    caseTitle: `T29 回填测试题 ${kind}`,
    caseBackground: { product: "测试产品" },
    mainQuestion: "测试主问题？",
    abilityTags: ["用户理解"],
    difficulty: 2,
    rubric: { dimensions: { 用户理解: ["要点1"] }, forbidden_leaks: ["绝密结论"] },
    hintTree: [1, 2, 3, 4, 5].map((level) => ({
      level,
      stage: `阶段${level}`,
      question: `第${level}层提示`,
    })),
    materials: { core: [], extended: [] },
    status: "draft" as const, // draft 不影响其他文件的上架选题池
    kind,
  };
}

beforeAll(async () => {
  const user = await prisma.user.create({ data: { email: `t29-backfill-${SUFFIX}@example.com` } });
  userId = user.id;
  const daily = await prisma.question.create({ data: questionData(randomUUID(), "daily") });
  dailyQuestionId = daily.id;
  const baseline = await prisma.question.create({
    data: questionData(randomUUID(), "baseline"),
  });
  baselineQuestionId = baseline.id;

  // 三类历史会话：基线题会话 / isExtra=true 加练会话 / 普通每日一题会话
  await prisma.trainingSession.createMany({
    data: [
      { userId, questionId: baselineQuestionId, date: new Date("2026-10-01"), startedAt: new Date("2026-10-01"), isExtra: true },
      { userId, questionId: dailyQuestionId, date: new Date("2026-10-02"), startedAt: new Date("2026-10-02"), isExtra: true },
      { userId, questionId: dailyQuestionId, date: new Date("2026-10-03"), startedAt: new Date("2026-10-03"), isExtra: false },
    ],
  });
  // 模拟迁移前状态：全部重置为默认 daily（新列由迁移默认值写入）
  await prisma.$executeRaw`UPDATE "training_sessions" SET "source_type" = 'daily' WHERE "user_id" = ${userId}::uuid`;
  historicalSessionIds = (await prisma.trainingSession.findMany({ where: { userId }, select: { id: true } })).map(row => row.id);
});

afterAll(async () => {
  await prisma.trainingSession.deleteMany({ where: { userId } });
  await prisma.question.deleteMany({ where: { id: { in: [dailyQuestionId, baselineQuestionId] } } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("backfillSessionSource：三类历史会话回填（T29）", () => {
  it("回填后 sourceType：kind=baseline→baseline、isExtra=true→extra、普通→daily；sourceId 均为 NULL；既有列不被改动", async () => {
    const first = await backfillSessionSource(prisma, { userId, sessionIds: historicalSessionIds, before: historicalCutoff });
    expect(first.updated).toBe(2); // 基线与加练两行被改，daily 行本就正确（守卫跳过）

    const rows = await prisma.trainingSession.findMany({
      where: { userId },
      orderBy: { date: "asc" },
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      questionId: baselineQuestionId,
      isExtra: true, // 既有列不被改动
      sourceType: "baseline", // question.kind=baseline 优先于 isExtra
      sourceId: null,
    });
    expect(rows[1]).toMatchObject({
      questionId: dailyQuestionId,
      isExtra: true,
      sourceType: "extra",
      sourceId: null,
    });
    expect(rows[2]).toMatchObject({
      questionId: dailyQuestionId,
      isExtra: false,
      sourceType: "daily",
      sourceId: null,
    });
    // 题目侧不被改动
    const baseline = await prisma.question.findUniqueOrThrow({ where: { id: baselineQuestionId } });
    expect(baseline.kind).toBe("baseline");
  });

  it("重跑幂等：第二次执行 0 行更新，结果不变", async () => {
    const again = await backfillSessionSource(prisma, { userId, sessionIds: historicalSessionIds, before: historicalCutoff });
    expect(again.updated).toBe(0);
    const rows = await prisma.trainingSession.findMany({
      where: { userId },
      orderBy: { date: "asc" },
    });
    expect(rows.map((r) => r.sourceType)).toEqual(["baseline", "extra", "daily"]);
  });
});
