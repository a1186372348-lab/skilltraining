import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import { getSessionSecret } from "@/server/modules/auth";
import { SESSION_COOKIE_NAME } from "@/server/modules/auth/cookies";
import { SESSION_TTL_MS, createSessionToken } from "@/server/modules/auth/session";

import { getRequestUser } from "./request-user";

// server/lib/request-user.ts 单测：会话 cookie → 用户解析的全部分支（T34）。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

async function createUser() {
  const user = await prisma.user.create({
    data: { email: `t34-request-user-${randomUUID()}@example.com` },
  });
  createdUserIds.push(user.id);
  return user;
}

function requestWithCookie(cookie?: string): Request {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost/api/x", { method: "GET", headers });
}

describe("getRequestUser（T34）", () => {
  it("无 cookie：返回 null", async () => {
    expect(await getRequestUser(prisma, requestWithCookie())).toBeNull();
  });

  it("cookie 头存在但无会话 cookie：返回 null", async () => {
    expect(
      await getRequestUser(prisma, requestWithCookie("other=1; theme=dark")),
    ).toBeNull();
  });

  it("伪造签名：返回 null", async () => {
    const user = await createUser();
    const forged = `${Buffer.from(
      JSON.stringify({ sub: user.id, email: user.email, exp: Date.now() + 1000 }),
    ).toString("base64url")}.forged-signature`;
    expect(
      await getRequestUser(
        prisma,
        requestWithCookie(`${SESSION_COOKIE_NAME}=${forged}`),
      ),
    ).toBeNull();
  });

  it("过期会话：返回 null", async () => {
    const user = await createUser();
    const expired = createSessionToken(
      { sub: user.id, email: user.email },
      getSessionSecret(),
      Date.now() - SESSION_TTL_MS - 1000,
    );
    expect(
      await getRequestUser(
        prisma,
        requestWithCookie(`${SESSION_COOKIE_NAME}=${expired}`),
      ),
    ).toBeNull();
  });

  it("有效 cookie：返回正确用户（多 cookie 并存时正确提取）", async () => {
    const user = await createUser();
    const token = createSessionToken(
      { sub: user.id, email: user.email },
      getSessionSecret(),
    );
    const found = await getRequestUser(
      prisma,
      requestWithCookie(`other=1; ${SESSION_COOKIE_NAME}=${token}; theme=dark`),
    );
    expect(found?.id).toBe(user.id);
    expect(found?.email).toBe(user.email);
  });

  it("令牌有效但用户不存在：返回 null", async () => {
    const token = createSessionToken(
      { sub: randomUUID(), email: "ghost@example.com" },
      getSessionSecret(),
    );
    expect(
      await getRequestUser(
        prisma,
        requestWithCookie(`${SESSION_COOKIE_NAME}=${token}`),
      ),
    ).toBeNull();
  });
});
