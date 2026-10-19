import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";
import { getBaselineStatus } from "@/server/modules/baseline/service";
import { triggerSessionScoring } from "@/server/modules/scoring/trigger";

import { GET } from "./route";

// GET /api/training/baseline 测试（T17a / D19；T36 / D38 补触发自愈）：mock 服务层验证出口形状，
// 避免在共享测试库上架基线题（全局门禁会干扰并行测试文件，见 baseline 服务测试注释）。
// 服务层分支逻辑（required/total/answeredCount/doneCount/幂等标记）见 server/modules/baseline/service.test.ts。
// 身份走真实会话 cookie（T34）；评分补触发以模块级 mock 验证（真实冒烟 0 次）。

vi.mock("@/server/modules/baseline/service", () => ({
  getBaselineStatus: vi.fn(),
}));

vi.mock("@/server/modules/scoring/trigger", () => ({
  triggerSessionScoring: vi.fn(),
}));

const mockedGetBaselineStatus = vi.mocked(getBaselineStatus);
const mockedTrigger = vi.mocked(triggerSessionScoring);

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

async function buildRequest(email?: string): Promise<Request> {
  const headers: Record<string, string> = {};
  if (email) {
    const user = await prisma.user.upsert({
      where: { email },
      create: { email },
      update: {},
    });
    createdUserIds.push(user.id);
    headers.cookie = sessionCookieHeader(user);
  }
  return new Request("http://localhost/api/training/baseline", { method: "GET", headers });
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("GET /api/training/baseline（T17a / D19）", () => {
  it("出口形状：下发 answeredCount/doneCount，nextQuestion 只含 id 与标题，待评分会话 id 不下发", async () => {
    mockedGetBaselineStatus.mockResolvedValue({
      required: true,
      total: 2,
      answeredCount: 1,
      doneCount: 0,
      nextQuestion: { id: "bq-2", caseTitle: "基线题二", rubric: "绝不外发" },
      completedAt: null,
      pendingScoringSessionIds: ["session-pending-1"],
    } as never);

    const email = `t17a-status-${randomUUID()}@example.com`;
    const res = await GET(await buildRequest(email));
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      required: true,
      total: 2,
      answeredCount: 1,
      doneCount: 0,
      nextQuestion: { id: "bq-2", caseTitle: "基线题二" },
      completedAt: null,
    });
    const raw = JSON.stringify(json);
    expect(raw).not.toContain("绝不外发");
    expect(raw).not.toContain("session-pending-1");
  });

  it("全部评完：required=false 且 completedAt 为 ISO 字符串", async () => {
    mockedGetBaselineStatus.mockResolvedValue({
      required: false,
      total: 2,
      answeredCount: 2,
      doneCount: 2,
      nextQuestion: null,
      completedAt: new Date("2026-10-04T00:00:00Z"),
      pendingScoringSessionIds: [],
    } as never);

    const email = `t17a-status-${randomUUID()}@example.com`;
    const res = await GET(await buildRequest(email));
    const json = await res.json();

    expect(json.data.required).toBe(false);
    expect(json.data.completedAt).toBe("2026-10-04T00:00:00.000Z");
  });

  it("生产环境无会话 cookie：401（T34）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(await buildRequest());
    expect(res.status).toBe(401);
    vi.unstubAllEnvs();
  });
});

describe("GET /api/training/baseline：已作答未评分会话补触发评分（T36 / D38 自愈通道）", () => {
  it("对待评分会话逐个后台补触发（终答触发失败时的重试兜底）", async () => {
    mockedTrigger.mockClear();
    mockedGetBaselineStatus.mockResolvedValue({
      required: true,
      total: 8,
      answeredCount: 8,
      doneCount: 5,
      nextQuestion: null,
      completedAt: null,
      pendingScoringSessionIds: ["session-p-1", "session-p-2", "session-p-3"],
    } as never);

    const email = `t36-status-${randomUUID()}@example.com`;
    const res = await GET(await buildRequest(email));
    expect(res.status).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(mockedTrigger).toHaveBeenCalledTimes(3);
    expect(mockedTrigger.mock.calls.map((call) => call[1])).toEqual([
      "session-p-1",
      "session-p-2",
      "session-p-3",
    ]);
    for (const call of mockedTrigger.mock.calls) {
      expect(call[2]).toBe(user.id);
    }
  });

  it("无待评分会话：不触发", async () => {
    mockedTrigger.mockClear();
    mockedGetBaselineStatus.mockResolvedValue({
      required: true,
      total: 2,
      answeredCount: 0,
      doneCount: 0,
      nextQuestion: { id: "bq-1", caseTitle: "基线题一" },
      completedAt: null,
      pendingScoringSessionIds: [],
    } as never);

    const email = `t36-status-${randomUUID()}@example.com`;
    const res = await GET(await buildRequest(email));
    expect(res.status).toBe(200);
    expect(mockedTrigger).not.toHaveBeenCalled();
  });
});
