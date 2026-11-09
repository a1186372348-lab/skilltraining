import type { PrismaClient } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";

import { BaselineRequiredError } from "@/server/modules/baseline/result-visibility";
import { PackError } from "@/server/modules/packs/errors";
import { ABILITY_DIMENSIONS } from "./schema";
import { getAbilityPageView } from "./ability-page";

const mocks = vi.hoisted(() => ({ guard: vi.fn(), profile: vi.fn(), availability: vi.fn() }));
vi.mock("@/server/modules/baseline/result-visibility", async (original) => ({
  ...(await original<typeof import("@/server/modules/baseline/result-visibility")>()),
  assertAbilityResultsVisible: mocks.guard,
}));
vi.mock("@/server/modules/packs", () => ({ getPackAvailability: mocks.availability }));
vi.mock("./ability", async (original) => ({
  ...(await original<typeof import("./ability")>()), getAbilityProfileView: mocks.profile,
}));

const db = { score: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaClient;
const statuses = ["available", "active_same_dimension", "active_other_dimension", "insufficient_questions", "baseline_required"] as const;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.guard.mockResolvedValue(undefined);
  mocks.profile.mockResolvedValue(ABILITY_DIMENSIONS.map((dimension) => ({
    dimension, observed: false, currentScore: null, observationCount: 0, hintDependency: null,
    hintDependencyBand: null, trend: null, updatedAt: null,
  })));
  mocks.availability.mockResolvedValue(ABILITY_DIMENSIONS.map((dimension, i) => ({
    dimension, status: statuses[i % statuses.length], activePackId: i === 1 || i === 2 ? "active-pack" : null,
    completedCount: i === 1 ? 2 : null, availableQuestions: i === 3 ? 3 : 6, requiredQuestions: 5,
  })));
});

it("单次批量只读装配八维包入口状态，保留当前包进度及不足原因", async () => {
  const view = await getAbilityPageView(db, "owner");
  expect(mocks.availability).toHaveBeenCalledTimes(1);
  expect(mocks.availability).toHaveBeenCalledWith(db, "owner", [...ABILITY_DIMENSIONS]);
  expect(view.dimensions.slice(0, 5).map((d) => d.packCta)).toMatchObject([
    { status: "available" },
    { status: "active-self", activePackId: "active-pack", completedCount: 2 },
    { status: "disabled-other-active", activePackId: "active-pack" },
    { status: "disabled-insufficient", availableQuestions: 3, requiredQuestions: 5 },
    { status: "baseline-required" },
  ]);
  expect(view.insight.nextFocus.mode).toBe("explore");
});

it("基线门禁先于包查询；并发重查失败时仍阻止画像揭晓", async () => {
  mocks.guard.mockRejectedValueOnce(new BaselineRequiredError());
  await expect(getAbilityPageView(db, "owner")).rejects.toBeInstanceOf(BaselineRequiredError);
  expect(mocks.availability).not.toHaveBeenCalled();
  mocks.availability.mockRejectedValueOnce(new PackError("BASELINE_REQUIRED", 409, "请先完成基线"));
  await expect(getAbilityPageView(db, "owner")).rejects.toBeInstanceOf(BaselineRequiredError);
});

it("包状态查询故障关闭，不以可发起或完整画像伪装成功", async () => {
  const error = new Error("storage unavailable");
  mocks.availability.mockRejectedValueOnce(error);
  await expect(getAbilityPageView(db, "owner")).rejects.toBe(error);
});

it("已观测维度继续逐次读取对应评分信心，非法值和 NULL 不冒充旧值", async () => {
  const dims = ABILITY_DIMENSIONS.map((dimension, index) => ({
    dimension, observed: index === 0, currentScore: index === 0 ? 60 : null, observationCount: index === 0 ? 3 : 0,
    hintDependency: index === 0 ? 1 : null, hintDependencyBand: index === 0 ? "低" : null,
    trend: index === 0 ? "上升" : null, updatedAt: null,
  }));
  mocks.profile.mockResolvedValue(dims);
  vi.mocked(db.score.findMany).mockResolvedValue([
    { effectiveScore: 62, confidence: null, session: { id: "latest", scoredAt: new Date("2026-01-03"), question: { caseTitle: "新案例" } } },
    { effectiveScore: 61, confidence: 0, session: { id: "zero", scoredAt: new Date("2026-01-02"), question: { caseTitle: "旧案例" } } },
    { effectiveScore: 60, confidence: 101, session: { id: "invalid", scoredAt: new Date("2026-01-01"), question: { caseTitle: "异常案例" } } },
  ] as never);
  const view = await getAbilityPageView(db, "owner");
  expect(view.dimensions[0].recentEvaluations.map((item) => item.confidence)).toEqual([null, 0, null]);
  expect(view.dimensions[0].recentScores).toEqual([60, 61, 62]);
  expect(view.dimensions[0].statusLabel).toBe("↑ 上升中");
});

it("批量结果缺少维度时失败关闭，不伪造入口状态", async () => {
  mocks.availability.mockResolvedValueOnce([]);
  await expect(getAbilityPageView(db, "owner")).rejects.toThrow("训练包可用性缺少维度");
});
