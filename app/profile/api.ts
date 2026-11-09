import type { AbilityPageView } from "./contract";

/**
 * 能力画像页 API 适配层（T09）。
 * 页面组件只调用本文件的函数，不直接 fetch；
 * 按统一响应封装 { success, data, error } 解析（同 app/training/session/api.ts 模式）。
 */

/** 统一响应封装的服务端错误形状（与 server/lib/api-response.ts 对齐） */
interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export class ProfileApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProfileApiError";
  }
}

/** GET /api/profile/ability：全 8 维画像视图 + 顶部洞察 + 整体提示依赖度 */
export async function fetchAbilityProfile(): Promise<AbilityPageView> {
  const res = await fetch("/api/profile/ability", {
    headers: { "content-type": "application/json" },
  });
  const json = (await res.json()) as ApiEnvelope<AbilityPageView>;
  if (!res.ok || !json.success) {
    throw new ProfileApiError(json.error?.code ?? "UNKNOWN", json.error?.message ?? "请求失败，请稍后重试");
  }
  return json.data as AbilityPageView;
}

/** 创建专项包；服务端在事务内重新校验基线、单包及未练题。 */
export async function createTrainingPack(dimension: string): Promise<string> {
  const res = await fetch("/api/packs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dimension }),
  });
  const json = (await res.json()) as ApiEnvelope<{ pack?: { id?: unknown } }>;
  if (!res.ok || !json.success) {
    throw new ProfileApiError(json.error?.code ?? "UNKNOWN", json.error?.message ?? "发起失败，请稍后重试");
  }
  const id = json.data?.pack?.id;
  if (typeof id !== "string" || !id) throw new Error("训练包信息暂不可用，请稍后重试");
  return id;
}
