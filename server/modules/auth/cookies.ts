import { SESSION_TTL_MS } from "./session";

/** 会话 cookie：httpOnly + SameSite=Lax（防 XSS 读取与跨站携带），生产环境强制 Secure */
export const SESSION_COOKIE_NAME = "st_session";

export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}
