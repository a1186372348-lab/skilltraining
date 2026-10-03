import type { HistoryDetailView, HistoryListView } from "./contract";
import { HISTORY_PAGE_SIZE } from "./view-model";

/**
 * 训练历史 API 适配层（T10）。
 * 页面组件只调用本文件的两个函数，不直接 fetch；
 * 按统一响应封装 { success, data, error } 解析，失败抛出带服务端 message 的错误。
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

/** GET /api/history：列表（按日期倒序 + 分页元数据） */
export async function fetchHistoryList(
  page: number,
  pageSize: number = HISTORY_PAGE_SIZE,
): Promise<HistoryListView> {
  return callApi<HistoryListView>(`/api/history?page=${page}&pageSize=${pageSize}`);
}

/** GET /api/history/:id：详情回放（缺失字段以 missing 标记） */
export async function fetchHistoryDetail(sessionId: string): Promise<HistoryDetailView> {
  return callApi<HistoryDetailView>(`/api/history/${sessionId}`);
}
