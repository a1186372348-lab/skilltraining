import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  findHistorySessionDetail,
} from "./repository";

// 历史模块数据访问集成测试（T10；T25 起仅保留详情——
// 列表分页查询已随 GET /api/history 删除）：真实数据库。
// 覆盖：详情行携带回放所需的全部关联（题目 / 提示事件 / 评分 / 反馈）。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

// 独立种子题 id（与 T05 及其他测试文件的种子题隔离，避免并发 upsert 互相覆盖）
const SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000b0";

async function ensureSeedQuestion(): Promise<void> {
  const data = {
    caseTitle: "T10 集成测试种子题",
    caseBackground: {
      product: "测试产品",
      audience: "测试用户",
      scenario: "测试场景",
      related_features: "测试功能",
      current_status: "测试状态",
    },
    mainQuestion: "测试主问题？",
    abilityTags: ["用户理解", "产品价值判断", "产品取舍"],
    difficulty: 2,
    rubric: { dimensions: {}, forbidden_leaks: [] },
    hintTree: [1, 2, 3, 4, 5].map((level) => ({
      level,
      stage: `阶段${level}`,
      question: `第${level}层提示`,
    })),
    materials: { core: [], extended: [] },
    status: "published" as const,
  };
  try {
    await prisma.question.upsert({
      where: { id: SEED_QUESTION_ID },
      create: { id: SEED_QUESTION_ID, ...data },
      update: data,
    });
  } catch {
    // 并发播种冲突：忽略
  }
}

async function newUser(prefix: string) {
  const user = await prisma.user.create({
    data: { email: `${prefix}-${randomUUID()}@example.com` },
  });
  createdUserIds.push(user.id);
  return user;
}

/** 为指定用户造一条会话；dayOffset 控制归属日（0 = 2026-10-01 起逐日 +N） */
async function newSession(
  userId: string,
  dayOffset: number,
  overrides: { state?: "reading" | "answering" | "followup" | "scored"; isExtra?: boolean } = {},
) {
  return prisma.trainingSession.create({
    data: {
      userId,
      questionId: SEED_QUESTION_ID,
      date: new Date(Date.UTC(2026, 9, 1 + dayOffset)),
      state: overrides.state ?? "scored",
      isExtra: overrides.isExtra ?? false,
      firstAnswer: "首答",
      firstSubmittedAt: new Date(),
      finalAnswer: "终答",
      finalSubmittedAt: new Date(),
    },
  });
}

beforeAll(ensureSeedQuestion);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("历史详情行（回放数据完整性）", () => {
  it("携带题目 / 提示事件（按请求时间升序）/ 评分四元组 / 反馈", async () => {
    const user = await newUser("t10-detail");
    const session = await newSession(user.id, 0);

    await prisma.hintEvent.createMany({
      data: [
        { sessionId: session.id, layer: 2, requestedAt: new Date(Date.UTC(2026, 9, 1, 6, 5)) },
        { sessionId: session.id, layer: 1, requestedAt: new Date(Date.UTC(2026, 9, 1, 6, 1)) },
      ],
    });
    await prisma.score.create({
      data: {
        sessionId: session.id,
        dimension: "用户理解",
        rawScore: 85,
        hintCount: 2,
        coefficient: 0.8,
        effectiveScore: 68,
        diagnosisText: "诊断文本",
      },
    });
    await prisma.sessionFeedback.create({
      data: {
        sessionId: session.id,
        topIssueText: "最需优化问题",
        nextFocusText: "下一步方向",
      },
    });

    const row = await findHistorySessionDetail(prisma, session.id);
    expect(row).not.toBeNull();
    expect(row?.question.mainQuestion).toBe("测试主问题？");
    // 提示事件按请求时间升序（层 1 在前）
    expect(row?.hintEvents.map((event) => event.layer)).toEqual([1, 2]);
    expect(row?.scores).toHaveLength(1);
    expect(row?.scores[0]).toMatchObject({
      dimension: "用户理解",
      rawScore: 85,
      coefficient: 0.8,
      effectiveScore: 68,
    });
    expect(row?.feedback).toMatchObject({
      topIssueText: "最需优化问题",
      nextFocusText: "下一步方向",
    });
  });

  it("不存在的会话返回 null", async () => {
    expect(await findHistorySessionDetail(prisma, randomUUID())).toBeNull();
  });
});
