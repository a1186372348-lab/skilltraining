import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ prisma: {} }));
import { getAuthService, getSessionSecret } from "./index";

describe("会话密钥读取", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("生产环境读取已配置密钥不依赖邮件配置", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SECRET", "x".repeat(32));
    vi.stubEnv("APP_BASE_URL", "");
    vi.stubEnv("SMTP_HOST", "");
    expect(getSessionSecret()).toBe("x".repeat(32));
  });
  it("生产环境会话读取拒绝弱密钥", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SECRET", "short");
    expect(() => getSessionSecret()).toThrow(/AUTH_SECRET/);
  });
  it("生产环境发登录链接前拒绝弱密钥", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SECRET", "short");
    vi.stubEnv("APP_BASE_URL", "https://training.example.com");
    vi.stubEnv("SMTP_HOST", "smtp.example.com");
    vi.stubEnv("SMTP_USER", "sender@example.com");
    vi.stubEnv("SMTP_PASS", "synthetic-password");
    expect(() => getAuthService()).toThrow(/AUTH_SECRET/);
  });
});
