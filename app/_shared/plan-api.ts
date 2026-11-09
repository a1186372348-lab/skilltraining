import {
  planPendingHintFor,
  type PlanProgressView,
  type TrainingPlanView,
  type WeeklyReviewView,
} from "./plan-view-model";

/**
 * 周期训练计划 API 适配层（T29 切片 5 / F5）：页面组件只调用本文件函数，不直接 fetch
 *（与 app/training/session/api.ts 同一模式）；统一响应封装 { success, data, error } 在此解析。
 * 契约见 server/modules/planning/schemas.ts（zod 收口，服务端已校验）。
 * 降级约定：接口或计划数据异常一律抛 PlanApiError，调用方按「不展示计划卡」降级，
 * 绝不影响今日训练主流程渲染（任务契约「失败与回滚」前端要求）。
 */

/** 统一响应封装的服务端错误形状（与 server/lib/api-response.ts 对齐） */
interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** 带服务端错误码的计划 API 错误：前端按 code 分支（PROFILE_INCOMPLETE → 待补测引导卡） */
export class PlanApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PlanApiError";
    this.code = code;
  }
}

async function callApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.success) {
    throw new PlanApiError(json.error?.code ?? "UNKNOWN", json.error?.message ?? "请求失败，请稍后重试");
  }
  return json.data as T;
}

/** GET /api/plans/current：本周计划（首访懒生成）；409 PROFILE_INCOMPLETE 以 PlanApiError 携带 */
export async function fetchCurrentPlan(): Promise<{ plan: TrainingPlanView; progress: PlanProgressView }> {
  return callApi("/api/plans/current");
}

/** POST /api/plans/reject：拒绝/撤销本周计划（幂等） */
export async function postPlanAction(
  action: "reject" | "unreject",
): Promise<{ plan: TrainingPlanView }> {
  return callApi("/api/plans/reject", { method: "POST", body: JSON.stringify({ action }) });
}

/** GET /api/plans/review：周回顾（周日前 review 为 null 未生成态） */
export async function fetchPlanReview(): Promise<{ review: WeeklyReviewView | null }> {
  return callApi("/api/plans/review");
}

/** 待补测引导文案（命中 409 PROFILE_INCOMPLETE 时返回文案，否则 null） */
export function pendingHintOf(error: unknown): string | null {
  const code = error instanceof PlanApiError ? error.code : null;
  return planPendingHintFor(code === "BASELINE_REQUIRED" ? "PROFILE_INCOMPLETE" : code);
}
