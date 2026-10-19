import { NextRequest } from "next/server";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "@/server/modules/auth/cookies";
import { resetAuthRateLimitersForTests } from "@/server/modules/auth/guards";
import { setAuthServiceForTests } from "@/server/modules/auth";
import type { Mailer } from "@/server/modules/auth/mailer";
import type {
  AuthRepository,
  IdentityWithUser,
  StoredMagicLinkToken,
} from "@/server/modules/auth/repository";
import { MAGIC_LINK_PROVIDER } from "@/server/modules/auth/repository";
import { AuthService } from "@/server/modules/auth/service";
import { createSessionToken, verifySessionToken } from "@/server/modules/auth/session";

import { POST as sendLinkPOST } from "@/app/api/auth/send-link/route";
import { GET as verifyGET } from "@/app/api/auth/verify/route";
import { GET as sessionGET } from "@/app/api/auth/session/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";

// 登录落点分发（核销成功后跳 /onboarding | /baseline | /）不属于本文件的认证契约范围：
// 三个落点分支由 app/api/auth/verify/route.test.ts（mock 分发）与
// server/modules/auth/post-login.test.ts（分发逻辑）覆盖。本文件固定返回 "/"，
// 聚焦 token 核销 / cookie / 失败口径；同时避免内存仓储的非 UUID 用户 id 触发真实库查询。

vi.mock("@/server/modules/auth/post-login", () => ({
  resolvePostLoginPath: vi.fn(async () => "/"),
}));

const TEST_SECRET = "routes-test-secret-0123456789abcdef";

/** 内存仓储（与 service.test.ts 同契约的最小实现） */
class InMemoryAuthRepository implements AuthRepository {
  users: IdentityWithUser[] = [];
  tokens: StoredMagicLinkToken[] = [];
  private seq = 0;

  async findIdentityByEmail(email: string): Promise<IdentityWithUser | null> {
    return (
      this.users.find(
        (u) => u.identity.provider === MAGIC_LINK_PROVIDER && u.identity.providerUid === email,
      ) ?? null
    );
  }

  async createUserWithIdentity(email: string): Promise<IdentityWithUser> {
    this.seq += 1;
    const created: IdentityWithUser = {
      user: { id: `user-${this.seq}`, email },
      identity: { id: `identity-${this.seq}`, provider: MAGIC_LINK_PROVIDER, providerUid: email },
    };
    this.users.push(created);
    return created;
  }

  async createMagicLinkToken(input: {
    identityId: string;
    tokenHash: string;
    expiresAt: Date;
    createdIp?: string | null;
  }): Promise<void> {
    const owner = this.users.find((u) => u.identity.id === input.identityId)!;
    this.tokens.push({
      id: `token-${this.tokens.length + 1}`,
      identityId: input.identityId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      usedAt: null,
      user: owner.user,
    });
  }

  async findTokenByHash(tokenHash: string): Promise<StoredMagicLinkToken | null> {
    return this.tokens.find((t) => t.tokenHash === tokenHash) ?? null;
  }

  async consumeMagicLinkToken(id: string, usedAt: Date): Promise<boolean> {
    const token = this.tokens.find((t) => t.id === id);
    if (!token || token.usedAt) return false;
    token.usedAt = usedAt;
    return true;
  }
}

class FakeMailer implements Mailer {
  sent: { to: string; link: string }[] = [];
  async sendMagicLink(to: string, link: string): Promise<void> {
    this.sent.push({ to, link });
  }
}

let mailer: FakeMailer;

beforeEach(() => {
  process.env.AUTH_SECRET = TEST_SECRET;
  mailer = new FakeMailer();
  setAuthServiceForTests(
    new AuthService({
      repo: new InMemoryAuthRepository(),
      mailer,
      baseUrl: "http://localhost:3000",
    }),
  );
  resetAuthRateLimitersForTests();
});

function postJson(url: string, body: unknown, ip = "10.0.0.1"): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function getReq(url: string, init?: { cookie?: string; ip?: string }): NextRequest {
  const headers = new Headers();
  if (init?.cookie) headers.set("cookie", init.cookie);
  headers.set("x-forwarded-for", init?.ip ?? "10.0.0.1");
  return new NextRequest(url, { method: "GET", headers });
}

async function issueTokenFor(email: string): Promise<string> {
  const res = await sendLinkPOST(postJson("http://localhost:3000/api/auth/send-link", { email }));
  expect(res.status).toBe(200);
  const link = mailer.sent[mailer.sent.length - 1].link;
  return new URL(link).searchParams.get("token")!;
}

describe("POST /api/auth/send-link（发送魔法链接）", () => {
  it("合法邮箱：统一成功口径，且不暴露邮箱是否已注册", async () => {
    const res = await sendLinkPOST(
      postJson("http://localhost:3000/api/auth/send-link", { email: "pm@example.com" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.data.message).toBe("string");
    // 响应中不含用户/身份标识，无法判断是否已注册
    expect(JSON.stringify(body)).not.toContain("user");
    expect(mailer.sent).toHaveLength(1);
  });

  it("非法邮箱：400 且不发信", async () => {
    const res = await sendLinkPOST(
      postJson("http://localhost:3000/api/auth/send-link", { email: "not-an-email" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: { code: "invalid_input", message: "请输入有效的邮箱地址" } });
    expect(mailer.sent).toHaveLength(0);
  });

  it("非 JSON 请求体：400", async () => {
    const res = await sendLinkPOST(postJson("http://localhost:3000/api/auth/send-link", "not-json{{{"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_input");
  });

  it("同一邮箱发送超频：429（service 按邮箱独立限流）", async () => {
    for (let i = 0; i < 5; i += 1) {
      await sendLinkPOST(postJson("http://localhost:3000/api/auth/send-link", { email: "pm@example.com" }));
    }
    const res = await sendLinkPOST(
      postJson("http://localhost:3000/api/auth/send-link", { email: "pm@example.com" }),
    );
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("rate_limited");
  });

  it("同一 IP 发送超频（换邮箱也不行）：429（发送接口独立 IP 限流）", async () => {
    for (let i = 0; i < 10; i += 1) {
      await sendLinkPOST(
        postJson("http://localhost:3000/api/auth/send-link", { email: `user${i}@example.com` }),
      );
    }
    const res = await sendLinkPOST(
      postJson("http://localhost:3000/api/auth/send-link", { email: "another@example.com" }),
    );
    expect(res.status).toBe(429);
  });

  it("认证端点统一限流：统一额度耗尽后所有认证端点 429", async () => {
    // 用会话端点消耗统一额度（60 次/15 分钟/IP）
    for (let i = 0; i < 60; i += 1) {
      await sessionGET(getReq("http://localhost:3000/api/auth/session"));
    }
    const res = await sendLinkPOST(
      postJson("http://localhost:3000/api/auth/send-link", { email: "pm@example.com" }),
    );
    expect(res.status).toBe(429);
  });
});

describe("GET /api/auth/verify（核销魔法链接）", () => {
  it("正确 token：302 重定向到首页并种下 httpOnly 会话 cookie", async () => {
    const token = await issueTokenFor("pm@example.com");

    const res = await verifyGET(getReq(`http://localhost:3000/api/auth/verify?token=${token}`));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    // cookie 值是有效会话
    const cookieValue = res.cookies.get(SESSION_COOKIE_NAME)?.value;
    expect(cookieValue).toBeTruthy();
    const session = verifySessionToken(cookieValue!, TEST_SECRET);
    expect(session?.email).toBe("pm@example.com");
  });

  it("错 token：重定向回登录页并携带错误提示，不种 cookie", async () => {
    const res = await verifyGET(getReq("http://localhost:3000/api/auth/verify?token=wrong-token"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=invalid_link");
    expect(res.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it("缺少 token 参数：重定向回登录页", async () => {
    const res = await verifyGET(getReq("http://localhost:3000/api/auth/verify"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=invalid_link");
  });

  it("重复使用同一链接：第二次重定向回登录页（一次性使用）", async () => {
    const token = await issueTokenFor("pm@example.com");
    const url = `http://localhost:3000/api/auth/verify?token=${token}`;

    const first = await verifyGET(getReq(url));
    const second = await verifyGET(getReq(url));

    expect(first.headers.get("location")).toBe("http://localhost:3000/");
    expect(second.headers.get("location")).toBe("http://localhost:3000/login?error=invalid_link");
  });
});

describe("GET /api/auth/session（当前会话）", () => {
  it("无 cookie：401", async () => {
    const res = await sessionGET(getReq("http://localhost:3000/api/auth/session"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  it("完整链路：登录后凭 cookie 读到当前用户", async () => {
    const token = await issueTokenFor("pm@example.com");
    const verifyRes = await verifyGET(getReq(`http://localhost:3000/api/auth/verify?token=${token}`));
    const cookie = verifyRes.cookies.get(SESSION_COOKIE_NAME)!.value;

    const res = await sessionGET(
      getReq("http://localhost:3000/api/auth/session", { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.user.email).toBe("pm@example.com");
    expect(typeof body.data.user.id).toBe("string");
  });

  it("篡改 cookie：401", async () => {
    const forged = createSessionToken({ sub: "x", email: "a@b.c" }, "wrong-secret");
    const res = await sessionGET(
      getReq("http://localhost:3000/api/auth/session", {
        cookie: `${SESSION_COOKIE_NAME}=${forged}`,
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/logout（注销）", () => {
  it("清除会话 cookie", async () => {
    const res = await logoutPOST(postJson("http://localhost:3000/api/auth/logout", {}));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(setCookie).toMatch(/Max-Age=0/i);
  });
});
