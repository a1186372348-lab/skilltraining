import type { TrainingHubView } from "./contract";

/**
 * 产品训练大厅 API 适配层（T25 / D27）。
 * 页面组件只调用本文件的函数，不直接 fetch；
 * 按统一响应封装 { success, data, error } 解析，失败抛出带服务端 message 的错误
 *（同 app/training/session/api.ts 模式；今日/加练入口复用 session/api.ts 的既有函数）。
 */

/** 统一响应封装的服务端错误形状（与 server/lib/api-response.ts 对齐） */
interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function callApi<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { "content-type": "application/json" } });
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.success) {
    throw new Error(json.error?.message ?? "请求失败，请稍后重试");
  }
  return json.data as T;
}

/** GET /api/training/hub：大厅载荷（当前训练卡三态 + 训练历史 + 连续训练天数） */
export async function fetchTrainingHub(): Promise<TrainingHubView> {
  return callApi<TrainingHubView>("/api/training/hub");
}
