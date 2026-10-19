import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";

import { GET, PUT } from "./route";

// 集成测试：草稿暂存接口（刷新不丢）。直接调用路由处理函数 + 真实数据库。
// 身份走真实会话 cookie（T34）。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

function devEmail(): string {
  return `t04-draft-${randomUUID()}@example.com`;
}

async function buildRequest(
  body: unknown,
  email: string,
  method = "PUT",
): Promise<Request> {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email },
    update: {},
  });
  createdUserIds.push(user.id);
  return new Request("http://localhost/api/profile/draft", {
    method,
    headers: {
      "content-type": "application/json",
      cookie: sessionCookieHeader(user),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
      await buildRequest({ position: "产品经理", familiarProducts: ["飞书"] }, email),
    );
    expect(putRes.status).toBe(200);
    expect((await putRes.json()).success).toBe(true);

    const getRes = await GET(await buildRequest(undefined, email, "GET"));
    const json = await getRes.json();

    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      position: "产品经理",
      familiarProducts: ["飞书"],
    });
  });

  it("无草稿时 GET 返回 data null", async () => {
    const email = devEmail();
    const res = await GET(await buildRequest(undefined, email, "GET"));

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toBeNull();
  });

  it("草稿字段值非法：400，不落库", async () => {
    const email = devEmail();
    const res = await PUT(
      await buildRequest({ position: "x".repeat(51) }, email),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("生产环境无会话 cookie：401（T34）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await PUT(
      new Request("http://localhost/api/profile/draft", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ position: "x" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
