import type { RetestStart, StageOverview } from "./contract";

export class StageApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "StageApiError"; }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const result = await response.json() as { success: boolean; data?: T; error?: { code: string; message: string } };
  if (!response.ok || !result.success || result.data === undefined) {
    throw new StageApiError(result.error?.code ?? "UNKNOWN", result.error?.message ?? "阶段状态暂时无法读取，请稍后重试");
  }
  return result.data;
}

export function fetchStageOverview(): Promise<StageOverview> {
  return request<StageOverview>("/api/stages/overview");
}

export function startRetest(triggerId: string): Promise<RetestStart> {
  return request<RetestStart>("/api/stages/retest/start", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ triggerId }),
  });
}
