import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

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
  if (env.NODE_ENV === "production") {
    const secret = env.AUTH_SECRET;
    if (!secret || /^\s/u.test(secret) || Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error("无效或缺少 AUTH_SECRET：生产环境会话签名密钥至少需要 32 字节且不能以空白开头");
    }
    return secret;
  }
  if (env.AUTH_SECRET) return env.AUTH_SECRET;
  ephemeralDevSecret ??= randomBytes(32).toString("hex");
  return ephemeralDevSecret;
}

function validHttpsOrigin(value: string | undefined): boolean {
  if (!value || !/^https:\/\/[^/?#]+\/?$/i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validSmtpHost(value: string): boolean {
  if (isIP(value)) return true;
  return value.length <= 253 && value.split(".").every(
    (label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
  );
}

function validateProductionConfig(env: Env): void {
  if (!validHttpsOrigin(env.APP_BASE_URL)) throw new Error("无效或缺少 APP_BASE_URL");
  for (const field of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"] as const) {
    if (!env[field]?.trim()) throw new Error(`无效或缺少 ${field}`);
  }
  if (!validSmtpHost(env.SMTP_HOST!)) throw new Error("无效 SMTP_HOST");
  if (env.SMTP_PORT && (!/^\d+$/.test(env.SMTP_PORT) || Number(env.SMTP_PORT) < 1 || Number(env.SMTP_PORT) > 65535)) {
    throw new Error("无效 SMTP_PORT");
  }
  if (env.SMTP_SECURE && env.SMTP_SECURE !== "true") throw new Error("无效 SMTP_SECURE");
  const from = env.SMTP_FROM || env.SMTP_USER!;
  if (!/^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(from)) {
    throw new Error("无效 SMTP_FROM 或 SMTP_USER");
  }
}

/** 读取完整认证配置；env 可注入以便测试 */
export function getAuthConfig(env: Env = process.env): AuthConfig {
  if (env.NODE_ENV === "production") validateProductionConfig(env);
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
