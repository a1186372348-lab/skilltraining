import type { DashboardView } from "@/server/modules/dashboard/contract";

/**
 * 首页仪表盘 API 适配层（T08-Page）。
 * 页面组件只调用本文件函数，不直接 fetch；统一响应封装 { success, data, error }
 * 的解析集中在这里（与 app/training/session/api.ts 同一模式）。
 */

/** 统一响应封装的服务端错误形状（与 server/lib/api-response.ts 对齐） */
interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** GET /api/dashboard：首页四卡数据（单卡为 null 即空态，不视为失败） */
export async function fetchDashboard(): Promise<DashboardView> {
  const res = await fetch("/api/dashboard", {
    headers: { "content-type": "application/json" },
  });
  const json = (await res.json()) as ApiEnvelope<DashboardView>;
  if (!res.ok || !json.success || !json.data) {
    throw new Error(json.error?.message ?? "请求失败，请稍后重试");
  }
  return json.data;
}
