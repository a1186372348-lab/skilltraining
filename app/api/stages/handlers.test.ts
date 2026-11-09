import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as requestUserModule from "@/server/lib/request-user";
import { StageError } from "@/server/modules/stages";
import * as stagesModule from "@/server/modules/stages";
import { UserTransactionError } from "@/server/lib/user-transaction";
import { createStageHandlers, type StageRouteDependencies } from "./handlers";
import { GET } from "./overview/route";
import { POST } from "./retest/start/route";

const triggerId = "123e4567-e89b-42d3-a456-426614174000";
const overview = { stage: "exploration" as const, baselineCompleted: false, dimensions: [], timeline: [] };

function deps(): StageRouteDependencies {
  return {
    getUser: vi.fn().mockResolvedValue({ id: "user" }),
    overview: vi.fn().mockResolvedValue(overview),
    start: vi.fn().mockResolvedValue({ state: "ready", triggerId, dimension: "问题定义", sessionId: triggerId, sessionState: "reading", awaitingScore: false }),
  };
}

function request(body: string) {
  return new Request("http://example.test/api/stages/retest/start", { method: "POST", body, headers: { "content-type": "application/json" } });
}

describe("阶段 API 边界", () => {
  it("未登录返回 401，不能执行读取或开题", async () => {
    const dependencies = deps();
    vi.mocked(dependencies.getUser).mockResolvedValue(null);
    const handlers = createStageHandlers(dependencies);
    expect((await handlers.overview(new Request("http://example.test"))).status).toBe(401);
    expect((await handlers.start(request(JSON.stringify({ triggerId })))).status).toBe(401);
    expect(dependencies.overview).not.toHaveBeenCalled();
    expect(dependencies.start).not.toHaveBeenCalled();
  });

  it("严格验证 JSON 和本人 triggerId，不接受附加字段", async () => {
    const dependencies = deps();
    const handlers = createStageHandlers(dependencies);
    for (const body of ["{", "{}", JSON.stringify({ triggerId: "invalid" }), JSON.stringify({ triggerId, userId: "other" })]) {
      expect((await handlers.start(request(body))).status).toBe(400);
    }
    expect(dependencies.start).not.toHaveBeenCalled();
    const result = await handlers.start(request(JSON.stringify({ triggerId })));
    expect(result.status).toBe(200);
    expect(dependencies.start).toHaveBeenCalledWith("user", triggerId);
  });

  it("仅输出安全 DTO，服务端基线与归属错误保持状态码", async () => {
    const dependencies = deps();
    const handlers = createStageHandlers(dependencies);
    const result = await handlers.overview(new Request("http://example.test"));
    expect(await result.json()).toMatchObject({ success: true, data: overview });
    vi.mocked(dependencies.start).mockRejectedValueOnce(new StageError("BASELINE_REQUIRED", 409, "先完成基线"));
    vi.mocked(dependencies.start).mockRejectedValueOnce(new StageError("STAGE_NOT_FOUND", 404, "复测不存在"));
    expect((await handlers.start(request(JSON.stringify({ triggerId })))).status).toBe(409);
    expect((await handlers.start(request(JSON.stringify({ triggerId })))).status).toBe(404);
  });

  it("账户消失返回 401；未知故障返回脱敏 500，不输出原异常", async () => {
    const dependencies = deps();
    const handlers = createStageHandlers(dependencies);
    vi.mocked(dependencies.overview).mockRejectedValueOnce(new UserTransactionError());
    expect((await handlers.overview(new Request("http://example.test"))).status).toBe(401);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const failure of [new Error("private synthetic detail"), "private synthetic detail"]) {
        vi.mocked(dependencies.start).mockRejectedValueOnce(failure);
        const response = await handlers.start(request(JSON.stringify({ triggerId })));
        expect(response.status).toBe(500);
        expect(JSON.stringify(await response.json())).not.toContain("private synthetic detail");
      }
      expect(JSON.stringify(spy.mock.calls)).not.toContain("private synthetic detail");
    } finally { spy.mockRestore(); }
  });
});

describe("阶段 API 限流", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("正式路由从认证用户取额度，超限后不调用阶段服务", async () => {
    const userId = "rate-default-route-user";
    const userSpy = vi.spyOn(requestUserModule, "getRequestUser").mockResolvedValue({
      id: userId, email: "synthetic@example.test", createdAt: new Date(),
    });
    const overviewSpy = vi.spyOn(stagesModule, "getStageOverview").mockResolvedValue(overview);
    const startSpy = vi.spyOn(stagesModule, "startRetest").mockResolvedValue({
      state: "ready", triggerId, dimension: "问题定义", sessionId: triggerId,
      sessionState: "reading", awaitingScore: false,
    });
    try {
      for (let i = 0; i < 30; i++) {
        expect((await GET(new Request("http://example.test/api/stages/overview"))).status).toBe(200);
        expect((await POST(request(JSON.stringify({ triggerId })))).status).toBe(200);
      }
      expect(overviewSpy).toHaveBeenCalledWith(expect.anything(), userId);
      expect(startSpy).toHaveBeenCalledWith(expect.anything(), userId, triggerId);
      overviewSpy.mockClear();
      startSpy.mockClear();
      expect((await GET(new Request("http://example.test/api/stages/overview"))).status).toBe(429);
      expect((await POST(request(JSON.stringify({ triggerId })))).status).toBe(429);
      expect(overviewSpy).not.toHaveBeenCalled();
      expect(startSpy).not.toHaveBeenCalled();
    } finally {
      userSpy.mockRestore();
      overviewSpy.mockRestore();
      startSpy.mockRestore();
    }
  });

  it.each(["overview", "start"] as const)("%s 按用户限制请求，窗口结束后恢复", async (endpoint) => {
    const dependencies = deps();
    vi.mocked(dependencies.getUser).mockResolvedValue({ id: `rate-window-${endpoint}` });
    const firstHandlers = createStageHandlers(dependencies);
    const anotherHandlers = createStageHandlers(dependencies);
    const call = (handlers: ReturnType<typeof createStageHandlers>) => endpoint === "overview"
      ? handlers.overview(new Request("http://example.test/api/stages/overview"))
      : handlers.start(request(JSON.stringify({ triggerId })));

    for (let i = 0; i < 30; i++) expect((await call(firstHandlers)).status).toBe(200);
    vi.mocked(dependencies.overview).mockClear();
    vi.mocked(dependencies.start).mockClear();

    const blocked = await call(anotherHandlers);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(await blocked.json()).toMatchObject({
      success: false,
      error: { code: "RATE_LIMITED", retryAfterSeconds: 60 },
    });
    expect(dependencies.overview).not.toHaveBeenCalled();
    expect(dependencies.start).not.toHaveBeenCalled();

    vi.mocked(dependencies.getUser).mockResolvedValueOnce(null);
    expect((await call(anotherHandlers)).status).toBe(401);
    expect(dependencies.overview).not.toHaveBeenCalled();
    expect(dependencies.start).not.toHaveBeenCalled();

    vi.advanceTimersByTime(59_999);
    const beforeExpiry = await call(anotherHandlers);
    expect(beforeExpiry.status).toBe(429);
    expect(beforeExpiry.headers.get("Retry-After")).toBe("1");
    expect(dependencies.overview).not.toHaveBeenCalled();
    expect(dependencies.start).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect((await call(anotherHandlers)).status).toBe(200);
    expect(dependencies[endpoint]).toHaveBeenCalledTimes(1);
  });

  it("不同用户及不同入口的额度互不影响", async () => {
    const dependencies = deps();
    let currentUser = "rate-independent-a";
    vi.mocked(dependencies.getUser).mockImplementation(async () => ({ id: currentUser }));
    const handlers = createStageHandlers(dependencies);
    const callOverview = () => handlers.overview(new Request("http://example.test/api/stages/overview"));
    const callStart = () => handlers.start(request(JSON.stringify({ triggerId })));

    for (let i = 0; i < 30; i++) expect((await callOverview()).status).toBe(200);
    expect((await callOverview()).status).toBe(429);
    expect((await callStart()).status).toBe(200);

    currentUser = "rate-independent-b";
    expect((await callOverview()).status).toBe(200);
    currentUser = "rate-independent-a";
    for (let i = 0; i < 29; i++) expect((await callStart()).status).toBe(200);
    expect((await callStart()).status).toBe(429);
    currentUser = "rate-independent-b";
    expect((await callStart()).status).toBe(200);
  });
});
