import { describe, expect, it } from "vitest";

import { getAuthConfig, resolveSessionSecret } from "./config";

// 配置：密钥与 SMTP 一律走环境变量，禁止硬编码
describe("认证配置", () => {
  it("AUTH_SECRET 存在时直接使用", () => {
    expect(resolveSessionSecret({ AUTH_SECRET: "x".repeat(32), NODE_ENV: "production" })).toBe(
      "x".repeat(32),
    );
  });

  it("生产环境缺少 AUTH_SECRET 时启动即失败（不静默降级）", () => {
    expect(() => resolveSessionSecret({ NODE_ENV: "production" })).toThrow(/AUTH_SECRET/);
  });

  it("开发环境缺少 AUTH_SECRET 时生成临时随机密钥且进程内稳定", () => {
    const first = resolveSessionSecret({ NODE_ENV: "development" });
    const second = resolveSessionSecret({ NODE_ENV: "development" });
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(second).toBe(first);
  });

  it("默认 baseUrl 为本地开发地址，可用 APP_BASE_URL 覆盖", () => {
    expect(getAuthConfig({ AUTH_SECRET: "s" }).baseUrl).toBe("http://localhost:3000");
    expect(getAuthConfig({ AUTH_SECRET: "s", APP_BASE_URL: "https://pm.example.com" }).baseUrl).toBe(
      "https://pm.example.com",
    );
  });

  it("SMTP 环境变量解析：默认端口与发件人", () => {
    const config = getAuthConfig({
      AUTH_SECRET: "s",
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "u",
      SMTP_PASS: "p",
    });
    expect(config.smtp).toEqual({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      user: "u",
      pass: "p",
      from: "u",
    });
  });

  it("SMTP_PORT / SMTP_SECURE / SMTP_FROM 可显式覆盖", () => {
    const config = getAuthConfig({
      AUTH_SECRET: "s",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "1025",
      SMTP_SECURE: "false",
      SMTP_FROM: "noreply@example.com",
    });
    expect(config.smtp.port).toBe(1025);
    expect(config.smtp.secure).toBe(false);
    expect(config.smtp.from).toBe("noreply@example.com");
  });

  it("未配置 SMTP_HOST 时 smtp.host 为 undefined（走控制台投递）", () => {
    expect(getAuthConfig({ AUTH_SECRET: "s" }).smtp.host).toBeUndefined();
  });
});

const productionEnv = {
  NODE_ENV: "production",
  AUTH_SECRET: "x".repeat(32),
  APP_BASE_URL: "https://training.example.com",
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "465",
  SMTP_SECURE: "true",
  SMTP_USER: "sender@example.com",
  SMTP_PASS: "test-password",
  SMTP_FROM: "sender@example.com",
};

describe("生产认证配置", () => {
  it.each([undefined, "", " ".repeat(32), "x".repeat(31), " " + "x".repeat(32), "\tx" + "x".repeat(32)])(
    "生产密钥无效时拒绝 %s", (value) => {
      expect(() => resolveSessionSecret({ NODE_ENV: "production", AUTH_SECRET: value })).toThrow(/AUTH_SECRET/);
      expect(() => getAuthConfig({ ...productionEnv, AUTH_SECRET: value })).toThrow(/AUTH_SECRET/);
    },
  );

  it("按 UTF-8 字节计算长度并保留原始密钥", () => {
    const secret = "密".repeat(11) + " ";
    expect(resolveSessionSecret({ NODE_ENV: "production", AUTH_SECRET: secret })).toBe(secret);
    expect(resolveSessionSecret({ NODE_ENV: "development", AUTH_SECRET: "short" })).toBe("short");
  });
  it("接受完整的隐式 TLS 配置及现有默认端口和发件人", () => {
    expect(getAuthConfig(productionEnv).smtp.secure).toBe(true);
    expect(getAuthConfig({ ...productionEnv, SMTP_PORT: undefined, SMTP_SECURE: undefined, SMTP_FROM: undefined }).smtp)
      .toMatchObject({ port: 465, secure: true, from: "sender@example.com" });
  });

  it.each([undefined, "", "http://example.com", "https://example.com/path", "https://user:pass@example.com", "https://example.com?x=1", "not-a-url"])(
    "拒绝无效的生产地址 %s", (value) => {
      expect(() => getAuthConfig({ ...productionEnv, APP_BASE_URL: value })).toThrow(/APP_BASE_URL/);
    },
  );

  it.each(["SMTP_HOST", "SMTP_USER", "SMTP_PASS"] as const)("拒绝缺失 %s", (field) => {
    expect(() => getAuthConfig({ ...productionEnv, [field]: " " })).toThrow(new RegExp(field));
  });

  it.each(["smtp.example.com:465", "https://smtp.example.com", "bad host", "example.com\r\nX: injected"])(
    "拒绝无效邮件服务器 %s", (value) => {
      expect(() => getAuthConfig({ ...productionEnv, SMTP_HOST: value })).toThrow(/SMTP_HOST/);
    },
  );

  it.each(["0", "65536", "465abc", "-1", "4.5"])("拒绝无效端口 %s", (value) => {
    expect(() => getAuthConfig({ ...productionEnv, SMTP_PORT: value })).toThrow(/SMTP_PORT/);
  });

  it.each(["false", "TRUE", "invalid"])("拒绝非隐式 TLS 配置 %s", (value) => {
    expect(() => getAuthConfig({ ...productionEnv, SMTP_SECURE: value })).toThrow(/SMTP_SECURE/);
  });

  it.each(["invalid", "sender@example.com\r\nBcc: victim@example.com"])("拒绝无效发件人", (value) => {
    expect(() => getAuthConfig({ ...productionEnv, SMTP_FROM: value })).toThrow(/SMTP_FROM/);
  });

  it("错误不包含输入值", () => {
    expect(() => getAuthConfig({ ...productionEnv, APP_BASE_URL: "secret-value" })).toThrow(/^.*APP_BASE_URL[^\n]*$/);
    try { getAuthConfig({ ...productionEnv, APP_BASE_URL: "secret-value" }); } catch (error) {
      expect(String(error)).not.toContain("secret-value");
    }
  });
});
