import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { getDashboardView } from "./service";

// T08 仪表盘装配服务测试：桩 DB 验证「单卡失败降级空态，不拖垮整页」。
// 路由级真实库集成测试见 app/api/dashboard/route.test.ts。

/** 昨天（UTC 日期键对齐用） */
function utcDaysAgo(days: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
}

const SEED_QUESTION = {
  id: "q-stub",
  caseTitle: "桩题",
  mainQuestion: "桩问题？",
  abilityTags: ["用户理解"],
};

describe("getDashboardView：各卡独立装配与降级", () => {
  it("诊断卡查询失败 → latestDiagnosis 空态，其余卡正常", async () => {
    const db = {
      trainingSession: {
        // 统计卡：昨天有终答 → 连续 1 天
        findMany: async () => [{ date: utcDaysAgo(1) }],
        // 今日任务卡：题库无上架题 → getOrCreateTodaySession 抛错 → 该卡降级
        findFirst: async () => null,
      },
      question: { findFirst: async () => null },
      abilityProfile: { findMany: async () => [] },
      sessionFeedback: {
        findFirst: async () => {
          throw new Error("db connection lost");
        },
      },
    } as unknown as PrismaClient;

    const view = await getDashboardView(db, "user-1");

    expect(view.latestDiagnosis).toBeNull(); // 失败卡降级
    expect(view.todayTask).toBeNull(); // 无上架题同样降级为空态（不拖垮整页）
    expect(view.stats?.streakDays).toBe(1); // 其余卡不受影响
    expect(view.ability?.unlockedCount).toBe(0);
    expect(view.ability?.unobserved).toHaveLength(8);
    expect(view.todayDateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("统计卡失败 → stats 空态，今日任务卡仍正常装配", async () => {
    const today = utcDaysAgo(0);
    const db = {
      trainingSession: {
        findMany: async (args?: { select?: { questionId?: boolean } }) => {
          // T11 接线后选题引擎也会查询 trainingSession（select questionId），予以放行；
          // 仅让连续天数统计查询（select date）失败，保持「统计卡失败」的测试意图
          if (args?.select?.questionId) return [];
          throw new Error("stats query failed");
        },
        findFirst: async () => null,
        create: async () => ({
          id: "s-1",
          state: "reading",
          finalSubmittedAt: null,
          date: today,
        }),
      },
      question: { findFirst: async () => SEED_QUESTION },
      abilityProfile: { findMany: async () => [{ dimension: "用户理解" }] },
      sessionFeedback: { findFirst: async () => null },
    } as unknown as PrismaClient;

    const view = await getDashboardView(db, "user-1");

    expect(view.stats).toBeNull(); // 失败卡降级
    expect(view.todayTask?.sessionId).toBe("s-1");
    expect(view.todayTask?.completed).toBe(false);
    // 用户理解已观测 → 为什么是它 走「结合画像推荐」占位文案
    expect(view.todayTask?.whyText).toContain("能力画像");
    expect(view.ability?.unlockedCount).toBe(1);
    expect(view.latestDiagnosis).toBeNull(); // 无反馈记录是正常空态
  });

  it("已评分会话的诊断被截断装配", async () => {
    const longIssue = "诊".repeat(120);
    const db = {
      trainingSession: {
        findMany: async () => [],
        findFirst: async () => null,
      },
      question: { findFirst: async () => null },
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

    expect(view.latestDiagnosis?.sessionId).toBe("s-9");
    expect(view.latestDiagnosis?.text).toHaveLength(91);
    expect(view.latestDiagnosis?.text.endsWith("…")).toBe(true);
  });
});
