import type { BaselineStatusView } from "./view-model";

/**
 * /baseline 页 API 适配层（T17a / D19；T36 / D38）。
 * 页面组件只调用本文件函数，不直接 fetch（与 app/training/session/api.ts 同一模式）；
 * 统一响应封装 { success, data, error } 的解析集中在这里。
 * T36 起评分由终答提交即触发 + 状态查询补触发承担，不再需要前端调反馈端点懒触发。
 */

/** 统一响应封装的服务端错误形状（与 server/lib/api-response.ts 对齐） */
interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** 真实接口调用：解析统一响应封装，失败时抛出带服务端 message 的错误 */
async function callApi<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { "content-type": "application/json" } });
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.success) {
    throw new Error(json.error?.message ?? "请求失败，请稍后重试");
  }
  return json.data as T;
}

/** GET /api/training/baseline：基线状态（required=false 即无需基线，老用户直达日常） */
export async function fetchBaselineStatus(): Promise<BaselineStatusView> {
  return callApi<BaselineStatusView>("/api/training/baseline");
}
