import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { getDashboardView } from "./service";

// T08 仪表盘装配服务测试：桩 DB 验证「单卡失败降级空态，不拖垮整页」。
// T26 / D28②：今日任务卡下线，currentTraining 复用大厅同源 getCurrentTrainingCard 装配。
// 路由级真实库集成测试见 app/api/dashboard/route.test.ts。

/** 昨天（UTC 日期键对齐用） */
function utcDaysAgo(days: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
}

/** 大厅装配行形状（对齐 hub-view 的 HUB_SESSION_SELECT） */
function hubRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "s-1",
    isExtra: false,
    state: "answering",
    finalSubmittedAt: null,
    startedAt: utcDaysAgo(0),
    question: { caseTitle: "案例一", abilityTags: ["用户理解"] },
    scores: [],
    ...overrides,
  };
}

describe("getDashboardView：各卡独立装配与降级", () => {
  it("当前训练卡查询失败 → currentTraining 空态，其余卡正常", async () => {
    const db = {
      trainingSession: {
        // 统计卡：昨天有终答 → 连续 1 天
        findMany: async () => [{ date: utcDaysAgo(1) }],
        // 当前训练卡：查询失败 → 该卡降级为 null（T08 约定，不拖垮整页）
        findFirst: async () => {
          throw new Error("db connection lost");
        },
      },
      abilityProfile: { findMany: async () => [] },
      sessionFeedback: { findFirst: async () => null },
    } as unknown as PrismaClient;

    const view = await getDashboardView(db, "user-1");

    expect(view.currentTraining).toBeNull(); // 失败卡降级
    expect(view.stats?.streakDays).toBe(1); // 其余卡不受影响
    expect(view.ability?.unlockedCount).toBe(0);
    expect(view.ability?.unobserved).toHaveLength(8);
    expect(view.latestDiagnosis).toBeNull();
    expect(view.todayDateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("统计卡失败 → stats 空态，当前训练卡正常下发（进行中）", async () => {
    const db = {
      trainingSession: {
        findMany: async () => {
          throw new Error("stats query failed");
        },
        // 当前训练卡：存在未完成非基线会话 → 进行中（追问中）
        findFirst: async (args: { where: { state: unknown } }) =>
          args.where.state === "scored" ? null : hubRow({ state: "followup" }),
      },
      abilityProfile: { findMany: async () => [{ dimension: "用户理解" }] },
      sessionFeedback: { findFirst: async () => null },
    } as unknown as PrismaClient;

    const view = await getDashboardView(db, "user-1");

    expect(view.stats).toBeNull(); // 失败卡降级
    expect(view.currentTraining).toEqual({
      kind: "in_progress",
      sessionId: "s-1",
      caseTitle: "案例一",
      stage: "followup",
    });
    expect(view.ability?.unlockedCount).toBe(1);
    expect(view.latestDiagnosis).toBeNull(); // 无反馈记录是正常空态
  });

  it("今日 daily 已评分 → 当前训练卡下发「已完成」（含 ≤3 条得分摘要）", async () => {
    const db = {
      trainingSession: {
        findMany: async () => [],
        findFirst: async (args: { where: { state: unknown } }) =>
          args.where.state === "scored"
            ? hubRow({
                id: "s-done",
                state: "scored",
                finalSubmittedAt: utcDaysAgo(0),
                scores: [{ dimension: "用户理解", effectiveScore: 82 }],
              })
            : null,
      },
      abilityProfile: { findMany: async () => [] },
      sessionFeedback: { findFirst: async () => null },
    } as unknown as PrismaClient;

    const view = await getDashboardView(db, "user-1");

    expect(view.currentTraining).toEqual({
      kind: "completed",
      sessionId: "s-done",
      caseTitle: "案例一",
      scores: [{ dimension: "用户理解", effectiveScore: 82 }],
    });
  });

  it("无任何会话 → 当前训练卡下发「未开始」；已评分会话的诊断被截断装配", async () => {
    const longIssue = "诊".repeat(120);
    const db = {
      trainingSession: {
        findMany: async () => [],
        findFirst: async () => null,
      },
      abilityProfile: { findMany: async () => [] },
      sessionFeedback: {
        findFirst: async () => ({
          sessionId: "s-9",
          topIssueText: longIssue,
          session: { date: utcDaysAgo(2) },
        }),
      },
    } as unknown as PrismaClient;

    const view = await getDashboardView(db, "user-1");

    expect(view.currentTraining?.kind).toBe("not_started");
    expect(view.latestDiagnosis?.sessionId).toBe("s-9");
    expect(view.latestDiagnosis?.text).toHaveLength(91);
    expect(view.latestDiagnosis?.text.endsWith("…")).toBe(true);
  });
});
