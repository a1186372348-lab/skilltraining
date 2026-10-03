import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { DEV_USER_HEADER } from "@/server/lib/dev-identity";

import { GET, PUT } from "./route";

// 集成测试：草稿暂存接口（刷新不丢）。直接调用路由处理函数 + 真实数据库。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

function devEmail(): string {
  return `t04-draft-${randomUUID()}@example.com`;
}

function buildRequest(body: unknown, email: string, method = "PUT"): Request {
  return new Request("http://localhost/api/profile/draft", {
    method,
    headers: {
      "content-type": "application/json",
      [DEV_USER_HEADER]: email,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function cleanupByEmail(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) createdUserIds.push(user.id);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("PUT + GET /api/profile/draft：草稿暂存", () => {
  it("保存草稿后可读回（刷新不丢），覆盖写以最新为准", async () => {
    const email = devEmail();
    const putRes = await PUT(
      buildRequest({ position: "产品经理", familiarProducts: ["飞书"] }, email),
    );
    expect(putRes.status).toBe(200);
    expect((await putRes.json()).success).toBe(true);

    const getRes = await GET(buildRequest(undefined, email, "GET"));
    const json = await getRes.json();
    await cleanupByEmail(email);

    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      position: "产品经理",
      familiarProducts: ["飞书"],
    });
  });

  it("无草稿时 GET 返回 data null", async () => {
    const email = devEmail();
    const res = await GET(buildRequest(undefined, email, "GET"));
    await cleanupByEmail(email);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toBeNull();
  });

  it("草稿字段值非法：400，不落库", async () => {
    const email = devEmail();
    const res = await PUT(
      buildRequest({ position: "x".repeat(51) }, email),
    );
    await cleanupByEmail(email);

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("生产环境（T03 未接入）无会话：401", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await PUT(buildRequest({ position: "x" }, devEmail()));
    expect(res.status).toBe(401);
  });
});
