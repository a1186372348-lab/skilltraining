import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";
import { getBaselineStatus } from "@/server/modules/baseline/service";

import { GET } from "./route";

// GET /api/training/baseline 测试（T17a / D19）：mock 服务层验证出口形状，
// 避免在共享测试库上架基线题（全局门禁会干扰并行测试文件，见 baseline 服务测试注释）。
// 服务层分支逻辑（required/total/doneCount/幂等标记）见 server/modules/baseline/service.test.ts。
// 身份走真实会话 cookie（T34）。

vi.mock("@/server/modules/baseline/service", () => ({
  getBaselineStatus: vi.fn(),
}));

const mockedGetBaselineStatus = vi.mocked(getBaselineStatus);

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
  it("出口形状：nextQuestion 只下发 id 与标题，completedAt 序列化为 ISO", async () => {
    mockedGetBaselineStatus.mockResolvedValue({
      required: true,
      total: 2,
      doneCount: 0,
      nextQuestion: { id: "bq-1", caseTitle: "基线题一", rubric: "绝不外发" },
      completedAt: null,
    } as never);

    const email = `t17a-status-${randomUUID()}@example.com`;
    const res = await GET(await buildRequest(email));
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      required: true,
      total: 2,
      doneCount: 0,
      nextQuestion: { id: "bq-1", caseTitle: "基线题一" },
      completedAt: null,
    });
    expect(JSON.stringify(json)).not.toContain("绝不外发");
  });

  it("全部评完：required=false 且 completedAt 为 ISO 字符串", async () => {
    mockedGetBaselineStatus.mockResolvedValue({
      required: false,
      total: 2,
      doneCount: 2,
      nextQuestion: null,
      completedAt: new Date("2026-10-04T00:00:00Z"),
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
