import { describe, expect, it } from "vitest";

import { getAuthConfig, resolveSessionSecret } from "./config";

// 配置：密钥与 SMTP 一律走环境变量，禁止硬编码
describe("认证配置", () => {
  it("AUTH_SECRET 存在时直接使用", () => {
    expect(resolveSessionSecret({ AUTH_SECRET: "prod-secret", NODE_ENV: "production" })).toBe(
      "prod-secret",
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
