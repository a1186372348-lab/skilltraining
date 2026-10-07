import type { ScoreNotificationItem } from "./view-model";

/**
 * 评分完成全局通知 API 适配层（T24 / Prd.md D26）。
 * 组件只调用本文件的函数，不直接 fetch；真实分支按统一响应封装
 * { success, data, error } 解析（同 app/training/session/api.ts 模式）。
 *
 * 与页面适配层的关键差异：失败一律静默返回空 items（401、网络错误、
 * 脏数据）——通知是增强能力，绝不因它影响任何页面渲染（任务契约失败与回滚）。
 */

/** 统一响应封装的服务端形状（与 server/lib/api-response.ts 对齐） */
interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** 防御解析：只保留形状合法的项，其余丢弃（绝不因脏数据抛错） */
function normalizeItems(raw: unknown): ScoreNotificationItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is ScoreNotificationItem =>
      item !== null &&
      typeof item === "object" &&
      typeof (item as ScoreNotificationItem).sessionId === "string" &&
      typeof (item as ScoreNotificationItem).caseTitle === "string" &&
      ((item as ScoreNotificationItem).kind === "scored" ||
        (item as ScoreNotificationItem).kind === "stuck") &&
      typeof (item as ScoreNotificationItem).occurredAt === "string",
  );
}

/** GET /api/training/score-notifications：可通知项；任何失败静默返回空数组 */
export async function fetchScoreNotifications(): Promise<ScoreNotificationItem[]> {
  try {
    const res = await fetch("/api/training/score-notifications", {
      headers: { "content-type": "application/json" },
    });
    const json = (await res.json()) as ApiEnvelope<{ items: unknown }>;
    if (!res.ok || !json.success) return [];
    return normalizeItems(json.data?.items);
  } catch {
    return [];
  }
}
