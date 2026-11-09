import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), status: vi.fn(), trigger: vi.fn() }));
vi.mock("@/server/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/server/lib/request-user", () => ({ getRequestUser: mocks.getUser }));
vi.mock("@/server/modules/baseline/service", () => ({ getBaselineStatus: mocks.status }));
vi.mock("@/server/modules/scoring/trigger", () => ({ triggerSessionScoring: mocks.trigger }));

import { aiEndpointRateLimiter } from "@/server/modules/training/rate-limit";
import { GET } from "./route";

const request = () => new Request("http://localhost/api/training/baseline");
const status = (pending: string[]) => ({
  required: true, total: 2, answeredCount: 1, doneCount: 0,
  nextQuestion: { id: "question-2", caseTitle: "下一题" },
  completedAt: null, pendingScoringSessionIds: pending, scoringPending: pending.length > 0,
  dimensionPreview: null, items: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  aiEndpointRateLimiter.reset();
  mocks.getUser.mockResolvedValue({ id: "baseline-user-1" });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("基线状态后台评分限流", () => {
  it("额度耗尽只暂停补触发，继续返回相同进度；其他用户仍可触发", async () => {
    mocks.status.mockResolvedValue(status(["pending-1", "pending-2"]));
    const first = await GET(request());
    const firstJson = await first.json();
    for (let i = 1; i < 30; i++) await GET(request());
    expect(mocks.trigger).toHaveBeenCalledTimes(60);

    const limited = await GET(request());
    expect(limited.status).toBe(200);
    expect(await limited.json()).toEqual(firstJson);
    expect(mocks.trigger).toHaveBeenCalledTimes(60);
    expect(JSON.stringify(firstJson)).not.toContain("pending-1");

    mocks.getUser.mockResolvedValue({ id: "baseline-user-2" });
    await GET(request());
    expect(mocks.trigger).toHaveBeenCalledTimes(62);
  });

  it("没有待评分会话时不检查或消耗评分额度", async () => {
    const check = vi.spyOn(aiEndpointRateLimiter, "check");
    mocks.status.mockResolvedValue(status([]));
    for (let i = 0; i < 35; i++) expect((await GET(request())).status).toBe(200);
    expect(check).not.toHaveBeenCalled();
    expect(mocks.trigger).not.toHaveBeenCalled();
    mocks.status.mockResolvedValue(status(["pending-1"]));
    await GET(request());
    expect(check).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledWith("baseline:baseline-user-1");
    expect(mocks.trigger).toHaveBeenCalledOnce();
  });

  it("限流器恢复放行后，下次轮询重新触发评分", async () => {
    vi.spyOn(aiEndpointRateLimiter, "check")
      .mockReturnValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 1 })
      .mockReturnValueOnce({ allowed: true, remaining: 29, retryAfterSeconds: 0 });
    mocks.status.mockResolvedValue(status(["pending-1"]));
    expect((await GET(request())).status).toBe(200);
    expect(mocks.trigger).not.toHaveBeenCalled();
    expect((await GET(request())).status).toBe(200);
    expect(mocks.trigger).toHaveBeenCalledOnce();
  });

  it("未登录不查状态、不消耗评分额度", async () => {
    const check = vi.spyOn(aiEndpointRateLimiter, "check");
    mocks.getUser.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(mocks.status).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });
});
