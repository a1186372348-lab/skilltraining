import type { ProfileData, SessionData } from "./contract";

/**
 * 我的页面 API 适配层（T15）。
 * 页面组件只调用本文件的函数，不直接 fetch；
 * 按统一响应封装 { success, data, error } 解析（同 app/training/session/api.ts 模式）。
 */

/** 统一响应封装的服务端错误形状（与 server/lib/api-response.ts 对齐） */
interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/**
 * GET /api/auth/session：读取当前登录身份。
 * 未登录/无 cookie 返回 null——由页面回退为 dev 占位身份展示（仅展示，不代表已登录）。
 */
export async function fetchSession(): Promise<SessionData | null> {
  const res = await fetch("/api/auth/session", {
    headers: { "content-type": "application/json" },
  });
  if (res.status === 401) return null;
  const json = (await res.json()) as ApiEnvelope<SessionData>;
  if (!res.ok || !json.success) {
    throw new Error(json.error?.message ?? "请求失败，请稍后重试");
  }
  return json.data ?? null;
}

/** GET /api/profile：读取初始画像（未提交过返回 null，卡片显示空态） */
export async function fetchProfile(): Promise<ProfileData | null> {
  const res = await fetch("/api/profile", {
    headers: { "content-type": "application/json" },
  });
  const json = (await res.json()) as ApiEnvelope<ProfileData | null>;
  if (!res.ok || !json.success) {
    throw new Error(json.error?.message ?? "请求失败，请稍后重试");
  }
  return json.data ?? null;
}

/** PUT /api/profile：保存画像（服务端 upsert 幂等，失败可原样重试）；失败抛错由调用方提示 */
export async function saveProfile(payload: Record<string, unknown>): Promise<void> {
  const res = await fetch("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await res.json()) as ApiEnvelope<ProfileData>;
  if (!res.ok || !json.success) {
    throw new Error(json.error?.message ?? "保存失败，请稍后重试");
  }
}

/** POST /api/auth/logout：注销会话；失败抛错由调用方提示 */
export async function logout(): Promise<void> {
  const res = await fetch("/api/auth/logout", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  const json = (await res.json()) as ApiEnvelope<{ message: string }>;
  if (!res.ok || !json.success) {
    throw new Error(json.error?.message ?? "退出失败，请稍后重试");
  }
}
