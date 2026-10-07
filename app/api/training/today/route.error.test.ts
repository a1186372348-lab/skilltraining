import { afterEach, describe, expect, it, vi } from "vitest";

import { DEV_USER_HEADER } from "@/server/lib/dev-identity";
import { TRAINING_ERROR_CODES, TrainingError } from "@/server/modules/training/errors";

import { GET } from "./route";

// GET /api/training/today 错误映射测试：mock 服务层抛业务错误（不出网、不碰数据库）。

vi.mock("@/server/modules/training/service", () => ({
  getOrCreateTodaySession: vi.fn(async () => {
    throw new TrainingError(TRAINING_ERROR_CODES.NO_PUBLISHED_QUESTION, 404, "题库暂无上架题目");
  }),
  // T21：路由先查当天最近非基线会话；返回 null 才会走到每日一题创建（错误抛出点）
  getLatestDailySession: vi.fn(async () => null),
}));

// T17a 门禁：固定返回「无需基线」，保证本测试不碰数据库、专注错误映射
vi.mock("@/server/modules/baseline/service", () => ({
  getBaselineStatus: vi.fn(async () => ({
    required: false,
    total: 0,
    doneCount: 0,
    nextQuestion: null,
    completedAt: null,
  })),
  getOrCreateBaselineSession: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/training/today：错误映射", () => {
  it("无上架题目：404 NO_PUBLISHED_QUESTION，统一错误封装", async () => {
    const request = new Request("http://localhost/api/training/today", {
      method: "GET",
      headers: { [DEV_USER_HEADER]: `t05-today-error-${Date.now()}@example.com` },
    });
    const res = await GET(request);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NO_PUBLISHED_QUESTION");
  });
});
