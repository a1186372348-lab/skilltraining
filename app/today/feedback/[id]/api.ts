import type { FeedbackView, SubmitSurveyResult } from "./contract";

/**
 * 训练反馈页 API 适配层（T07）。
 * 页面组件只调用本文件的函数，不直接 fetch；
 * 真实分支按统一响应封装 { success, data, error } 解析（同 app/today/api.ts 模式）。
 */

/** 统一响应封装的服务端错误形状（与 server/lib/api-response.ts 对齐） */
interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** 真实接口调用：解析统一响应封装，失败时抛出带服务端 message 的错误 */
async function callApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.success) {
    throw new Error(json.error?.message ?? "请求失败，请稍后重试");
  }
  return json.data as T;
}

/**
 * GET /api/training/:id/feedback：懒触发评分 + 反馈视图。
 * 评分未完成时返回 { status: "scoring" }，前端轮询（真实延迟 35~49 秒）。
 */
export function fetchFeedback(sessionId: string): Promise<FeedbackView> {
  return callApi<FeedbackView>(`/api/training/${sessionId}/feedback`);
}

export interface SurveySubmission {
  sessionId: string;
  q1Clarity: number;
  q2Next: number;
  /** 仅触发周期（needsPeriodicQ3）时携带 */
  periodicQ3?: number;
}

/** POST /api/feedback-survey：提交感知问卷（幂等，可安全重试） */
export function submitSurvey(input: SurveySubmission): Promise<SubmitSurveyResult> {
  return callApi<SubmitSurveyResult>("/api/feedback-survey", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
