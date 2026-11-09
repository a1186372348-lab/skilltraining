import { randomUUID } from "node:crypto";

import type { TrainingPlan } from "@prisma/client";
import { describe, expect, it } from "vitest";

import type { AbilityProfileDimensionView } from "@/server/modules/profile/ability";
import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";

import { PLANNING_ERROR_CODES } from "./errors";
import type { PlanningRepository } from "./repository";
import {
  getOrCreateCurrentPlan,
  getOrGenerateWeeklyReview,
  getPlanProgress,
  setCurrentPlanStatus,
  weekStartUtc,
} from "./service";
import type { PrismaClient } from "@prisma/client";

// planning service 单测（T29 / F5）：mock repository 与画像视图，不触真实库、不调 AI。
// 规则来源：D30（周一懒生成）、D35（targetScore = min(100, 当前分+10)；未知维度不参与排序——
// 存在未知维度暂缓生成）、D33②/BR-V2-2（拒绝后本周不再推荐）、蓝图 §2.4（周日周回顾 + 归档）。

const db = {} as PrismaClient; // service 只经 repository 访问数据，桩 PrismaClient 不出网

const MON_0 = new Date(Date.UTC(2026, 9, 19)); // 2026-10-19 周一
const WED_0 = new Date(Date.UTC(2026, 9, 21)); // 周三
const SUN_0 = new Date(Date.UTC(2026, 9, 25)); // 周日（本周第 7 天）
const NEXT_MON = new Date(Date.UTC(2026, 9, 26)); // 下周一

function makePlan(overrides: Partial<TrainingPlan> = {}): TrainingPlan {
  return {
    id: randomUUID(),
    userId: "u-1",
    weekStartDate: MON_0,
    focusDimension: "产品取舍",
    startScore: 55,
    targetScore: 65,
    status: "active",
    reason: "「产品取舍」是你当前最弱的维度（当前 55 分），本周集中攻它，目标 65 分。",
    createdAt: new Date("2026-10-19T08:00:00Z"),
    ...overrides,
  } as TrainingPlan;
}

/** 全 8 维画像视图构造（score 为 null 即未知） */
function profileOf(entries: [string, number | null][]): AbilityProfileDimensionView[] {
  const byDimension = new Map(entries);
  return ABILITY_DIMENSIONS.map((dimension) => ({
    dimension,
    observed: byDimension.get(dimension) !== null && byDimension.get(dimension) !== undefined,
    currentScore: byDimension.get(dimension) ?? null,
    observationCount: 1,
    hintDependency: null,
    hintDependencyBand: null,
    trend: null,
    updatedAt: null,
  })) as AbilityProfileDimensionView[];
}

const FULL_PROFILE = profileOf([
  ["问题定义", 80],
  ["用户理解", 76],
  ["根因分析", 82],
  ["产品价值判断", 70],
  ["方案设计", 78],
  ["产品取舍", 55],
  ["指标与验证", 88],
  ["产品表达", 90],
]);

interface RepoStub {
  plans: TrainingPlan[];
  planSessions: { scoredAt: Date }[];
  created: unknown[];
  statusWrites: { id: string; status: string }[];
  latestScore?: number;
  failNextCreate?: boolean; // 模拟并发撞唯一约束（P2002）
}

function makeRepo(stub: RepoStub): PlanningRepository {
  return {
    findPlanById: async (userId, id) => stub.plans.find((p) => p.userId === userId && p.id === id) ?? null,
    findPlanByWeek: async (_userId, weekStart) =>
      stub.plans.find((p) => p.weekStartDate.getTime() === weekStart.getTime()) ?? null,
    findLatestPlan: async () => stub.plans[stub.plans.length - 1] ?? null,
    createPlan: async (data) => {
      stub.created.push(data);
      if (stub.failNextCreate) {
        stub.failNextCreate = false;
        // 并发首访撞 @@unique(userId, weekStartDate)：抛错后回读既有
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      const plan = makePlan({ ...data, id: randomUUID(), status: "active" } as Partial<TrainingPlan>);
      stub.plans.push(plan);
      return plan;
    },
    updatePlanStatus: async (id, status) => {
      stub.statusWrites.push({ id, status });
      const plan = stub.plans.find((p) => p.id === id);
      if (!plan) throw new Error("not found");
      // 桩内同步状态（幂等用例的第二次调用读到新状态）
      stub.plans = stub.plans.map((p) => (p.id === id ? ({ ...p, status } as TrainingPlan) : p));
      return { ...plan, status } as TrainingPlan;
    },
    changePlanStatus: async (_userId, id, expected, status) => {
      const current = stub.plans.find((p) => p.id === id)!;
      if (current.status !== expected) return current;
      stub.statusWrites.push({ id, status });
      const updated = { ...current, status };
      stub.plans = stub.plans.map((p) => p.id === id ? updated : p);
      return updated;
    },
    findReviewablePlan: async (_userId, latestWeek) => [...stub.plans].reverse().find((p) => p.weekStartDate <= latestWeek) ?? null,
    averageScoreUntil: async () => stub.latestScore ?? 55,
    saveReviewSnapshot: async (_userId, plan, snapshot) => {
      const current = stub.plans.find((p) => p.id === plan.id)!;
      if (current.reviewSnapshot != null) return current;
      const status = current.status === "active" ? "completed" : current.status;
      if (current.status === "active") stub.statusWrites.push({ id: current.id, status });
      const saved = { ...current, status, reviewSnapshot: snapshot } as TrainingPlan;
      stub.plans = stub.plans.map((p) => p.id === plan.id ? saved : p);
      return saved;
    },
    listPlanScoredSessions: async () => stub.planSessions,
  };
}

describe("weekStartUtc：周一 0 点（UTC）", () => {
  it("周三 → 本周一；周一当天 → 当天；周日 → 本周一（周日属本周）", () => {
    expect(weekStartUtc(WED_0).getTime()).toBe(MON_0.getTime());
    expect(weekStartUtc(MON_0).getTime()).toBe(MON_0.getTime());
    expect(weekStartUtc(SUN_0).getTime()).toBe(MON_0.getTime());
  });
});

describe("getOrCreateCurrentPlan：周一懒生成（D30）", () => {
  it("本周无记录 → 生成：focusDimension=画像最低分维度，targetScore=min(100, 当前分+10)，reason 含维度名与当前分", async () => {
    const stub: RepoStub = { plans: [], planSessions: [], created: [], statusWrites: [] };
    const repo = makeRepo(stub);
    const plan = await getOrCreateCurrentPlan(db, "u-1", {
      repository: repo,
      getProfileView: async () => FULL_PROFILE,
      now: WED_0,
    });
    expect(plan.focusDimension).toBe("产品取舍"); // 最低分 55
    expect(plan.startScore).toBe(55);
    expect(plan.targetScore).toBe(65); // min(100, 55+10)
    expect(plan.reason).toContain("产品取舍");
    expect(plan.reason).toContain("55");
    expect(plan.weekStartDate.getTime()).toBe(MON_0.getTime());
    expect(stub.created).toHaveLength(1);
  });

  it("同分按 ABILITY_DIMENSIONS 固定顺序取前者", async () => {
    const tied = profileOf([
      ["问题定义", 60],
      ["用户理解", 60], // 与问题定义同分，顺序在后者不选
      ["根因分析", 82],
      ["产品价值判断", 70],
      ["方案设计", 78],
      ["产品取舍", 75],
      ["指标与验证", 88],
      ["产品表达", 90],
    ]);
    const plan = await getOrCreateCurrentPlan(db, "u-1", {
      repository: makeRepo({ plans: [], planSessions: [], created: [], statusWrites: [] }),
      getProfileView: async () => tied,
      now: WED_0,
    });
    expect(plan.focusDimension).toBe("问题定义");
  });

  it("已有本周记录 → 幂等返回，不重复创建", async () => {
    const existing = makePlan();
    const stub: RepoStub = { plans: [existing], planSessions: [], created: [], statusWrites: [] };
    const repo = makeRepo(stub);
    const plan = await getOrCreateCurrentPlan(db, "u-1", {
      repository: repo,
      getProfileView: async () => FULL_PROFILE,
      now: WED_0,
    });
    expect(plan.id).toBe(existing.id);
    expect(stub.created).toHaveLength(0);
  });

  it("并发首访撞唯一约束 → 回读既有计划，不双写", async () => {
    const existing = makePlan();
    const stub: RepoStub = { plans: [], planSessions: [], created: [], statusWrites: [], failNextCreate: true };
    const repo = makeRepo(stub);
    // 首次 find 无 → create 撞 P2002 → 再次 find 命中（并发另一方已写）
    const origFind = repo.findPlanByWeek;
    let findCalls = 0;
    repo.findPlanByWeek = async () => {
      findCalls += 1;
      return findCalls === 1 ? null : existing;
    };
    void origFind;
    const plan = await getOrCreateCurrentPlan(db, "u-1", {
      repository: repo,
      getProfileView: async () => FULL_PROFILE,
      now: WED_0,
    });
    expect(plan.id).toBe(existing.id);
    expect(stub.created).toHaveLength(1); // 只尝试创建一次（被撞）
  });

  it("存在未知维度（currentScore 为 NULL）→ 不生成，抛 PROFILE_INCOMPLETE 提示先完成基线测评（D35）", async () => {
    const withUnknown = profileOf([
      ["问题定义", 80],
      ["用户理解", null], // 未知维度
      ["根因分析", 82],
      ["产品价值判断", 70],
      ["方案设计", 78],
      ["产品取舍", 55],
      ["指标与验证", 88],
      ["产品表达", 90],
    ]);
    const stub: RepoStub = { plans: [], planSessions: [], created: [], statusWrites: [] };
    const repo = makeRepo(stub);
    await expect(
      getOrCreateCurrentPlan(db, "u-1", {
        repository: repo,
        getProfileView: async () => withUnknown,
        now: WED_0,
      }),
    ).rejects.toMatchObject({ code: PLANNING_ERROR_CODES.PROFILE_INCOMPLETE });
    expect(stub.created).toHaveLength(0); // 未创建
  });
});

describe("setCurrentPlanStatus：拒绝与撤销（D33② / BR-V2-2，幂等）", () => {
  it("active → rejected；已是 rejected 幂等不重复写", async () => {
    const plan = makePlan();
    const stub: RepoStub = { plans: [plan], planSessions: [], created: [], statusWrites: [] };
    const repo = makeRepo(stub);
    const rejected = await setCurrentPlanStatus(db, "u-1", "rejected", {
      repository: repo,
      now: WED_0,
    });
    expect(rejected.status).toBe("rejected");
    expect(stub.statusWrites).toHaveLength(1);
    // 幂等：再次拒绝不重复写
    const again = await setCurrentPlanStatus(db, "u-1", "rejected", { repository: repo, now: WED_0 });
    expect(again.status).toBe("rejected");
    expect(stub.statusWrites).toHaveLength(1);
  });

  it("rejected → active（撤销）幂等；无本周计划抛 PLAN_NOT_FOUND", async () => {
    const plan = makePlan({ status: "rejected" });
    const repo = makeRepo({ plans: [plan], planSessions: [], created: [], statusWrites: [] });
    const restored = await setCurrentPlanStatus(db, "u-1", "active", { repository: repo, now: WED_0 });
    expect(restored.status).toBe("active");

    await expect(
      setCurrentPlanStatus(db, "u-1", "rejected", {
        repository: makeRepo({ plans: [], planSessions: [], created: [], statusWrites: [] }),
        now: WED_0,
      }),
    ).rejects.toMatchObject({ code: PLANNING_ERROR_CODES.PLAN_NOT_FOUND });
  });
});

describe("getPlanProgress：进度聚合（sourceType=plan 且已评分）", () => {
  it("已评分会话数与按 date 去重的完成天数；空记录为 0/0", async () => {
    const plan = makePlan();
    const repo = makeRepo({
      plans: [plan],
      planSessions: [
        { scoredAt: new Date(Date.UTC(2026, 9, 19)) },
        { scoredAt: new Date(Date.UTC(2026, 9, 19)) },
        { scoredAt: new Date(Date.UTC(2026, 9, 21)) },
      ],
      created: [],
      statusWrites: [],
    });
    const progress = await getPlanProgress(db, "u-1", plan, { repository: repo });
    expect(progress).toEqual({ scoredCount: 3, completedDays: 2, completedDates: ["2026-10-19", "2026-10-21"] });

    const empty = await getPlanProgress(db, "u-1", plan, {
      repository: makeRepo({ plans: [plan], planSessions: [], created: [], statusWrites: [] }),
    });
    expect(empty).toEqual({ scoredCount: 0, completedDays: 0, completedDates: [] });
  });
});

describe("getOrGenerateWeeklyReview：周日周回顾与归档（蓝图 §2.4）", () => {
  it("周日前返回未生成态（null，不写库）", async () => {
    const stub: RepoStub = { plans: [makePlan()], planSessions: [], created: [], statusWrites: [] };
    const repo = makeRepo(stub);
    const review = await getOrGenerateWeeklyReview(db, "u-1", {
      repository: repo,
      getProfileView: async () => FULL_PROFILE,
      now: WED_0, // 周三
    });
    expect(review).toBeNull();
    expect(stub.statusWrites).toHaveLength(0);
  });

  it("周日首访生成周回顾：完成天数 + 主攻维度有效分变化（startScore → 最新有效分），计划归档 completed", async () => {
    const latest = profileOf([
      ["问题定义", 80],
      ["用户理解", 76],
      ["根因分析", 82],
      ["产品价值判断", 70],
      ["方案设计", 78],
      ["产品取舍", 62], // startScore 55 → 62
      ["指标与验证", 88],
      ["产品表达", 90],
    ]);
    const plan = makePlan();
    const stub: RepoStub = {
      plans: [plan],
      latestScore: 62,
      planSessions: [
        { scoredAt: new Date(Date.UTC(2026, 9, 20)) },
        { scoredAt: new Date(Date.UTC(2026, 9, 22)) },
        { scoredAt: new Date(Date.UTC(2026, 9, 22)) },
      ],
      created: [],
      statusWrites: [],
    };
    const repo = makeRepo(stub);
    const review = await getOrGenerateWeeklyReview(db, "u-1", {
      repository: repo,
      getProfileView: async () => latest,
      now: SUN_0,
    });
    expect(review).not.toBeNull();
    expect(review!.completedDays).toBe(2);
    expect(review!.scoredCount).toBe(3);
    expect(review!.startScore).toBe(55);
    expect(review!.latestScore).toBe(62);
    expect(review!.scoreChange).toBe(7); // 口径与 ability 有效分事实源一致（画像当前分）
    // 归档：active → completed
    expect(stub.statusWrites).toEqual([{ id: plan.id, status: "completed" }]);
    expect(review!.plan.status).toBe("completed");
  });

  it("下周一回看上周计划同样生成并归档；已归档重复调用幂等（不重复写）", async () => {
    const plan = makePlan({ status: "completed" });
    const stub: RepoStub = { plans: [plan], planSessions: [], created: [], statusWrites: [] };
    const repo = makeRepo(stub);
    const review = await getOrGenerateWeeklyReview(db, "u-1", {
      repository: repo,
      getProfileView: async () => FULL_PROFILE,
      now: NEXT_MON,
    });
    expect(review).not.toBeNull();
    expect(review!.plan.status).toBe("completed");
    expect(stub.statusWrites).toHaveLength(0); // 已归档不重复写
  });

  it("新周已生成计划时仍回顾上周并以周末为截止", async () => {
    const previous = makePlan();
    const current = makePlan({ id: randomUUID(), weekStartDate: NEXT_MON });
    const stub: RepoStub = { plans: [previous, current], planSessions: [], created: [], statusWrites: [] };
    const repo = makeRepo(stub);
    let cutoff: Date | undefined;
    repo.averageScoreUntil = async (_user, _dimension, end) => { cutoff = end; return 55; };
    const review = await getOrGenerateWeeklyReview(db, "u-1", { repository: repo, now: NEXT_MON });
    expect(review?.plan.id).toBe(previous.id);
    expect(cutoff).toEqual(NEXT_MON);
  });
  it("并发首次回顾固定同一快照，迟到评分不改变结果", async () => {
    const stub: RepoStub = { plans: [makePlan()], planSessions: [], created: [], statusWrites: [] };
    const repo = makeRepo(stub);
    const deps = { repository: repo, getProfileView: async () => FULL_PROFILE, now: NEXT_MON };
    const [first, concurrent] = await Promise.all([
      getOrGenerateWeeklyReview(db, "u-1", deps), getOrGenerateWeeklyReview(db, "u-1", deps),
    ]);
    expect(concurrent).toEqual(first);
    stub.planSessions.push({ scoredAt: new Date(Date.UTC(2026, 9, 25, 23, 59)) });
    const later = await getOrGenerateWeeklyReview(db, "u-1", deps);
    expect(later).toEqual(first);
  });
  it("同周拒绝快照后仍可撤销，已固定的回顾不变", async () => {
    const plan = makePlan({ status: "rejected" });
    const stub: RepoStub = { plans: [plan], planSessions: [], created: [], statusWrites: [] };
    const repo = makeRepo(stub);
    const before = await getOrGenerateWeeklyReview(db, "u-1", { repository: repo, now: SUN_0 });
    const active = await setCurrentPlanStatus(db, "u-1", "active", { repository: repo, now: SUN_0 });
    expect(active.status).toBe("active");
    const after = await getOrGenerateWeeklyReview(db, "u-1", { repository: repo, now: SUN_0 });
    expect(after?.scoreChange).toBe(before?.scoreChange);
    expect(after?.scoredCount).toBe(before?.scoredCount);
    expect(after?.plan.reviewSnapshot).toEqual(before?.plan.reviewSnapshot);
  });

  it("周日回顾保留拒绝状态，允许同周撤销", async () => {
    const plan = makePlan({ status: "rejected" });
    const stub: RepoStub = { plans: [plan], planSessions: [], created: [], statusWrites: [] };
    const review = await getOrGenerateWeeklyReview(db, "u-1", {
      repository: makeRepo(stub), getProfileView: async () => FULL_PROFILE, now: SUN_0,
    });
    expect(review?.plan.status).toBe("rejected");
    expect(stub.statusWrites).toEqual([]);
  });
  it("无计划 → 未生成态（null）", async () => {
    const review = await getOrGenerateWeeklyReview(db, "u-1", {
      repository: makeRepo({ plans: [], planSessions: [], created: [], statusWrites: [] }),
      getProfileView: async () => FULL_PROFILE,
      now: SUN_0,
    });
    expect(review).toBeNull();
  });
});
