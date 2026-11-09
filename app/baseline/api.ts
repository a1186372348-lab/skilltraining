import type { BaselineStatusView } from "./view-model";
import { ApiError } from "../training/session/api";

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

/** GET /api/training/baseline：基线状态（required=false 即无需基线，老用户直达日常） */
export async function fetchBaselineStatus(): Promise<BaselineStatusView> {
  const res = await fetch("/api/training/baseline", { headers: { "content-type": "application/json" } });
  if (res.status === 401) {
    throw new ApiError("UNAUTHORIZED", "未登录或登录已过期");
  }
  const json = (await res.json().catch(() => null)) as ApiEnvelope<BaselineStatusView> | null;
  if (!res.ok || !json?.success || !json.data) {
    throw new ApiError(json?.error?.code ?? "UNKNOWN", json?.error?.message ?? "测评暂时无法加载，请重试");
  }
  return json.data;
}
