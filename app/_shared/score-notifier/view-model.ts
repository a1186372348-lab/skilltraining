/**
 * 评分完成全局通知的决策纯函数（T24 / Prd.md D26）。
 *
 * 全部判定逻辑落在本文件（组件只负责渲染与调用）：
 * - 去重键 `${sessionId}:${kind}`（D26④：同会话 scored 与 stuck 各自可弹一次）；
 * - 已通知键持久化在 localStorage，上限 50 条 FIFO（错过通知后下次打开补弹一次）；
 * - 首次加载（localStorage 无记录）时 occurredAt 超 30 分钟的历史项静默标记不弹
 *   （防弹窗风暴），30 分钟内正常弹；
 * - 当前路径为该会话反馈页时标记已通知但不弹不响（D26③：页面自身轮询原地出分）；
 * - 同屏至多 3 条，其余排队，关闭后队首补位。
 */

export type ScoreNotificationKind = "scored" | "stuck";

export interface ScoreNotificationItem {
  sessionId: string;
  caseTitle: string;
  kind: ScoreNotificationKind;
  /** ISO 时间（scored 取 scoredAt，stuck 取 finalSubmittedAt） */
  occurredAt: string;
}

/** 同屏至多弹出的通知卡数，其余排队 */
export const MAX_VISIBLE_NOTIFICATIONS = 3;
/** localStorage 已通知键上限（FIFO 截断） */
export const MAX_NOTIFIED_KEYS = 50;
/** 首载静默窗口：occurredAt 早于该时长的历史项只标记不弹 */
export const FIRST_LOAD_SILENCE_MS = 30 * 60 * 1000;
/** localStorage 存储键 */
export const NOTIFIED_STORAGE_KEY = "skilltraining.score-notifier.notified";

/** 去重键：`${sessionId}:${kind}`（D26④） */
export function notificationKey(item: Pick<ScoreNotificationItem, "sessionId" | "kind">): string {
  return `${item.sessionId}:${item.kind}`;
}

/** 会话对应的反馈页路径（抑制判定与跳转共用同一口径；T25 / D27：迁入产品训练模块） */
export function feedbackPathFor(sessionId: string): string {
  return `/training/feedback/${sessionId}`;
}

export interface NotificationDecision {
  /** 本次应弹卡的新通知（未做同屏截断，由队列函数接管） */
  toNotify: ScoreNotificationItem[];
  /** 应并入已通知集合的键（含静默标记项与 toNotify 的键） */
  keysToMark: string[];
}

/**
 * 通知决策：对服务端 items 逐项判定——
 * 已通知 → 跳过；在该会话反馈页 → 静默标记（不弹不响）；
 * 首载且超过静默窗口 → 静默标记；其余 → 弹出并标记。
 */
export function decideNotifications(input: {
  items: ScoreNotificationItem[];
  notifiedKeys: readonly string[];
  pathname: string;
  nowMs: number;
  /** localStorage 是否已有记录（false = 首次加载，适用 30 分钟静默规则） */
  hasStoredKeys: boolean;
}): NotificationDecision {
  const notified = new Set(input.notifiedKeys);
  const toNotify: ScoreNotificationItem[] = [];
  const keysToMark: string[] = [];

  for (const item of input.items) {
    const key = notificationKey(item);
    if (notified.has(key)) continue;
    keysToMark.push(key);
    if (input.pathname === feedbackPathFor(item.sessionId)) continue;
    const occurredMs = Date.parse(item.occurredAt);
    const staleOnFirstLoad =
      !input.hasStoredKeys &&
      Number.isFinite(occurredMs) &&
      input.nowMs - occurredMs > FIRST_LOAD_SILENCE_MS;
    if (staleOnFirstLoad) continue;
    toNotify.push(item);
  }
  return { toNotify, keysToMark };
}

/** 已通知键追加：去重后按 FIFO 截断到上限（最早的键先被挤出） */
export function appendNotifiedKeys(
  existing: readonly string[],
  newKeys: readonly string[],
): string[] {
  const merged = [...existing];
  for (const key of newKeys) {
    if (!merged.includes(key)) merged.push(key);
  }
  return merged.slice(-MAX_NOTIFIED_KEYS);
}

/** 持久化数据防御解析：非法数据按"无记录"处理（触发首载静默，绝不弹窗风暴） */
export function parseStoredKeys(raw: string | null): {
  keys: string[];
  hasStoredKeys: boolean;
} {
  if (raw === null) return { keys: [], hasStoredKeys: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      return { keys: [], hasStoredKeys: false };
    }
    return { keys: parsed as string[], hasStoredKeys: true };
  } catch {
    return { keys: [], hasStoredKeys: false };
  }
}

/** 通知卡队列状态：可见区 + 排队区 */
export interface NotificationQueueState {
  visible: ScoreNotificationItem[];
  queue: ScoreNotificationItem[];
}

/** 新通知入队：可见位未满补满，其余排队（不可变，返回新状态） */
export function enqueueNotifications(
  state: NotificationQueueState,
  incoming: readonly ScoreNotificationItem[],
): NotificationQueueState {
  const room = MAX_VISIBLE_NOTIFICATIONS - state.visible.length;
  return {
    visible: [...state.visible, ...incoming.slice(0, Math.max(room, 0))],
    queue: [...state.queue, ...incoming.slice(Math.max(room, 0))],
  };
}

/** 关闭一张卡：从可见区移除，队首补位 */
export function dismissNotification(
  state: NotificationQueueState,
  key: string,
): NotificationQueueState {
  const visible = state.visible.filter((item) => notificationKey(item) !== key);
  if (visible.length === state.visible.length) return state;
  const room = MAX_VISIBLE_NOTIFICATIONS - visible.length;
  return {
    visible: [...visible, ...state.queue.slice(0, room)],
    queue: state.queue.slice(room),
  };
}
