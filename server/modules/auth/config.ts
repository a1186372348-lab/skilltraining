import { randomBytes } from "node:crypto";

/**
 * 认证模块配置：密钥与 SMTP 参数一律来自环境变量（禁止硬编码）。
 * AUTH_SECRET 用于会话 cookie 签名：生产环境必须显式配置，缺失即启动失败；
 * 开发环境缺失时生成进程级临时随机密钥（重启后会话失效，仅影响本地体验）。
 */

export interface SmtpConfig {
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export interface AuthConfig {
  baseUrl: string;
  sessionSecret: string;
  smtp: SmtpConfig;
}

type Env = Record<string, string | undefined>;

// 开发环境临时密钥：进程内缓存，保证多次读取一致
let ephemeralDevSecret: string | null = null;

/** 解析会话签名密钥；env 可注入以便测试 */
export function resolveSessionSecret(env: Env): string {
  if (env.AUTH_SECRET) return env.AUTH_SECRET;
  if (env.NODE_ENV === "production") {
    throw new Error("缺少环境变量 AUTH_SECRET：生产环境必须配置会话签名密钥");
  }
  ephemeralDevSecret ??= randomBytes(32).toString("hex");
  return ephemeralDevSecret;
}

/** 读取完整认证配置；env 可注入以便测试 */
export function getAuthConfig(env: Env = process.env): AuthConfig {
  const smtpUser = env.SMTP_USER || undefined;
  return {
    baseUrl: env.APP_BASE_URL || "http://localhost:3000",
    sessionSecret: resolveSessionSecret(env),
    smtp: {
      host: env.SMTP_HOST || undefined,
      port: env.SMTP_PORT ? Number.parseInt(env.SMTP_PORT, 10) : 465,
      // 默认按 465 隐式 TLS；明文中继（如本地 Mailhog）设 SMTP_SECURE=false
      secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : true,
      user: smtpUser,
      pass: env.SMTP_PASS || undefined,
      from: env.SMTP_FROM || smtpUser || "noreply@localhost",
    },
  };
}
