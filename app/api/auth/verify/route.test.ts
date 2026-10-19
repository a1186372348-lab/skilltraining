import { NextRequest } from "next/server";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { setAuthServiceForTests } from "@/server/modules/auth";
import { SESSION_COOKIE_NAME } from "@/server/modules/auth/cookies";
import { resetAuthRateLimitersForTests } from "@/server/modules/auth/guards";
import type { Mailer } from "@/server/modules/auth/mailer";
import { resolvePostLoginPath } from "@/server/modules/auth/post-login";
import type {
  AuthRepository,
  IdentityWithUser,
  StoredMagicLinkToken,
} from "@/server/modules/auth/repository";
import { MAGIC_LINK_PROVIDER } from "@/server/modules/auth/repository";
import { AuthService } from "@/server/modules/auth/service";
import { generateMagicLinkToken } from "@/server/modules/auth/token";

import { GET } from "./route";

// GET /api/auth/verify 登录落点分发测试（首登链路：问卷 → 基线 → 画像揭晓）。
// mock 落点分发模块：三个落点分支在本文件确定性断言；分发逻辑本身见
// server/modules/auth/post-login.test.ts。认证契约（token 一次性、失败统一口径、
// cookie 可验签）的既有覆盖见 server/modules/auth/routes.test.ts。

vi.mock("@/server/modules/auth/post-login", () => ({
  resolvePostLoginPath: vi.fn(),
}));

const mockedResolve = vi.mocked(resolvePostLoginPath);

const TEST_SECRET = "verify-route-test-secret-0123456789abcdef";

/** 内存仓储（与 server/modules/auth/routes.test.ts 同契约的最小实现） */
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

let repo: InMemoryAuthRepository;

beforeEach(() => {
  process.env.AUTH_SECRET = TEST_SECRET;
  repo = new InMemoryAuthRepository();
  setAuthServiceForTests(
    new AuthService({
      repo,
      mailer: new FakeMailer(),
      baseUrl: "http://localhost:3000",
    }),
  );
  resetAuthRateLimitersForTests();
  mockedResolve.mockReset();
});

function getReq(url: string): NextRequest {
  return new NextRequest(url, {
    method: "GET",
    headers: { "x-forwarded-for": "10.0.0.2" },
  });
}

/** 直接落库一枚有效一次性 token（不经发信链路），返回明文 token 与所属用户 */
async function issueValidToken(email: string) {
  const { user, identity } = await repo.createUserWithIdentity(email);
  const generated = generateMagicLinkToken();
  await repo.createMagicLinkToken({
    identityId: identity.id,
    tokenHash: generated.tokenHash,
    expiresAt: generated.expiresAt,
  });
  return { token: generated.token, user };
}

describe("GET /api/auth/verify（登录落点分发）", () => {
  it("无画像行用户：核销成功 → /onboarding，会话 cookie 仍种植", async () => {
    mockedResolve.mockResolvedValue("/onboarding");
    const { token, user } = await issueValidToken("new@example.com");

    const res = await GET(getReq(`http://localhost:3000/api/auth/verify?token=${token}`));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/onboarding");
    // 分发以核销出的真实用户 id 入参
    expect(mockedResolve).toHaveBeenCalledWith(expect.anything(), user.id);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
  });

  it("有画像行但基线未完成用户：核销成功 → /baseline", async () => {
    mockedResolve.mockResolvedValue("/baseline");
    const { token } = await issueValidToken("baseline@example.com");

    const res = await GET(getReq(`http://localhost:3000/api/auth/verify?token=${token}`));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/baseline");
    expect(res.cookies.get(SESSION_COOKIE_NAME)?.value).toBeTruthy();
  });

  it("全部完成用户：核销成功 → / 首页", async () => {
    mockedResolve.mockResolvedValue("/");
    const { token } = await issueValidToken("done@example.com");

    const res = await GET(getReq(`http://localhost:3000/api/auth/verify?token=${token}`));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
  });

  it("无效 token：→ /login?error=invalid_link，不种 cookie，不触发落点分发", async () => {
    const res = await GET(getReq("http://localhost:3000/api/auth/verify?token=wrong-token"));

    expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=invalid_link");
    expect(res.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it("缺少 token 参数：→ /login?error=invalid_link", async () => {
    const res = await GET(getReq("http://localhost:3000/api/auth/verify"));

    expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=invalid_link");
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it("统一限流耗尽：→ /login?error=rate_limited，不触发落点分发", async () => {
    // 统一限流每 IP 15 分钟 60 次：先以无效 token 请求耗尽额度
    for (let i = 0; i < 60; i += 1) {
      await GET(getReq("http://localhost:3000/api/auth/verify?token=wrong-token"));
    }
    const { token } = await issueValidToken("limited@example.com");
    const res = await GET(getReq(`http://localhost:3000/api/auth/verify?token=${token}`));

    expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=rate_limited");
    expect(mockedResolve).not.toHaveBeenCalled();
  });
});
