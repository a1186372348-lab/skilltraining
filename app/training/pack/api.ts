import type { PackDetail } from "./contract";

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export class PackApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PackApiError";
  }
}

async function callApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !body.success || body.data === undefined) {
    throw new PackApiError(body.error?.code ?? "UNKNOWN", body.error?.message ?? "请求失败，请稍后重试");
  }
  return body.data;
}

export async function fetchActivePack(): Promise<PackDetail | null> {
  return (await callApi<{ pack: PackDetail | null }>("/api/packs/active")).pack;
}
export async function fetchPack(id: string): Promise<PackDetail> {
  return (await callApi<{ pack: PackDetail }>(`/api/packs/${encodeURIComponent(id)}`)).pack;
}
export async function createPack(dimension: string): Promise<PackDetail> {
  return (await callApi<{ pack: PackDetail }>("/api/packs", { method: "POST", body: JSON.stringify({ dimension }) })).pack;
}
export async function startPackItem(id: string, index: number): Promise<{ sessionId: string; state: string }> {
  return callApi(`/api/packs/${encodeURIComponent(id)}/items/${index}/start`, { method: "POST" });
}
export async function abandonPack(id: string): Promise<PackDetail> {
  return (await callApi<{ pack: PackDetail }>(`/api/packs/${encodeURIComponent(id)}/abandon`, { method: "POST", body: JSON.stringify({ confirmed: true }) })).pack;
}
/** 仅在用户已明确确认“终止整包”后调用。 */
export async function abandonPackSession(sessionId: string): Promise<{ sessionId: string; state: string }> {
  return callApi(`/api/training/${encodeURIComponent(sessionId)}/abandon`, { method: "POST", body: JSON.stringify({ confirmAbandonPack: true }) });
}
