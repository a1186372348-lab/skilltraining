import { afterEach, describe, expect, it, vi } from "vitest";

import { DEV_USER_HEADER } from "@/server/lib/dev-identity";
import { TRAINING_ERROR_CODES, TrainingError } from "@/server/modules/training/errors";

import { GET } from "./route";

// GET /api/training/today 错误映射测试：mock 服务层抛业务错误（不出网、不碰数据库）。

vi.mock("@/server/modules/training/service", () => ({
  getOrCreateTodaySession: vi.fn(async () => {
    throw new TrainingError(TRAINING_ERROR_CODES.NO_PUBLISHED_QUESTION, 404, "题库暂无上架题目");
  }),
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
