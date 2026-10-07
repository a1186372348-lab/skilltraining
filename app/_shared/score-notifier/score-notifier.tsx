"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchScoreNotifications } from "./api";
import {
  NOTIFIED_STORAGE_KEY,
  appendNotifiedKeys,
  decideNotifications,
  dismissNotification,
  enqueueNotifications,
  feedbackPathFor,
  notificationKey,
  parseStoredKeys,
  type NotificationQueueState,
  type ScoreNotificationItem,
} from "./view-model";

/**
 * 评分完成全局通知组件（T24 / Prd.md D26）：挂在根布局，任意页面生效。
 *
 * 行为：挂载即查 + 每 10 秒轮询 GET /api/training/score-notifications；
 * 新通知弹右上角常驻卡（同屏至多 3 条，其余排队、关闭后补位）并播放
 * 两音「叮」（Web Audio 现场合成，无音频素材，D26②）；
 * scored 卡「训练评分完成 / 查看评分结果」、stuck 卡「评分遇到波动 / 点击查看」，
 * 点击跳 /training/feedback/[id] 并关闭（T25 / D27 路径），× 仅关闭。
 *
 * 失败与回滚（任务契约）：fetch、localStorage、AudioContext 全部 try/catch
 * 静默——401（登录页）、网络错误、隐私模式一律降级，绝不因通知功能
 * 导致任何页面渲染异常；localStorage 不可用时降级为本次会话内存去重。
 * 全部决策逻辑在 view-model 纯函数，本组件只做渲染、轮询与副作用兜底。
 */

const POLL_INTERVAL_MS = 10_000;

const CARD =
  "rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_8px_24px_rgba(15,23,42,0.12)]";
const PRIMARY_BTN =
  "rounded-xl bg-[#2563EB] px-4 py-2 text-sm font-bold text-white shadow-[0_4px_12px_rgba(37,99,235,0.25)] transition-colors hover:bg-[#1D4ED8]";

/** 已通知键存取：localStorage 持久化，读写失败时降级为内存镜像（隐私模式） */
interface NotifiedKeyStore {
  load(): { keys: string[]; hasStoredKeys: boolean };
  append(newKeys: string[]): void;
}

function createNotifiedKeyStore(): NotifiedKeyStore {
  let memory = { keys: [] as string[], hasStoredKeys: false };
  return {
    load() {
      try {
        const parsed = parseStoredKeys(window.localStorage.getItem(NOTIFIED_STORAGE_KEY));
        memory = parsed;
        return parsed;
      } catch {
        return memory;
      }
    },
    append(newKeys) {
      if (newKeys.length === 0) return;
      const current = this.load();
      memory = { keys: appendNotifiedKeys(current.keys, newKeys), hasStoredKeys: true };
      try {
        window.localStorage.setItem(NOTIFIED_STORAGE_KEY, JSON.stringify(memory.keys));
      } catch {
        // 持久化失败：内存镜像已更新，本次会话内去重仍生效
      }
    },
  };
}

/** 两音「叮」：880Hz → 1320Hz 正弦、共约 0.3s；播放失败静默，不影响弹窗 */
function playDing(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const startAt = ctx.currentTime;
    for (const [frequency, offset] of [
      [880, 0],
      [1320, 0.12],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, startAt + offset);
      gain.gain.exponentialRampToValueAtTime(0.15, startAt + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(startAt + offset);
      osc.stop(startAt + offset + 0.2);
    }
    // 发声结束后释放 AudioContext，避免轮询长期累积实例
    window.setTimeout(() => {
      void ctx.close().catch(() => undefined);
    }, 600);
  } catch {
    // 浏览器自动播放策略拦截等：静默
  }
}

export function ScoreNotifier() {
  const router = useRouter();
  const pathname = usePathname();
  const [cards, setCards] = useState<NotificationQueueState>({ visible: [], queue: [] });
  // cards 镜像 ref：副作用内基于最新状态计算与发声判定，setState 保持纯更新
  const cardsRef = useRef(cards);
  const storeRef = useRef<NotifiedKeyStore | null>(null);
  // pathname 经 ref 透传给轮询闭包（不重建 10 秒轮询）；渲染期禁写 ref，走 effect 同步
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  /** 应用新队列状态：可见区新增的卡触发一次提示音 */
  const applyCards = useCallback((next: NotificationQueueState) => {
    const appeared = next.visible.filter(
      (item) =>
        !cardsRef.current.visible.some((prev) => notificationKey(prev) === notificationKey(item)),
    );
    cardsRef.current = next;
    setCards(next);
    if (appeared.length > 0) playDing();
  }, []);

  useEffect(() => {
    storeRef.current ??= createNotifiedKeyStore();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll(): Promise<void> {
      try {
        const items = await fetchScoreNotifications();
        if (!cancelled && items.length > 0 && storeRef.current) {
          const stored = storeRef.current.load();
          const decision = decideNotifications({
            items,
            notifiedKeys: stored.keys,
            pathname: pathnameRef.current,
            nowMs: Date.now(),
            hasStoredKeys: stored.hasStoredKeys,
          });
          storeRef.current.append(decision.keysToMark);
          if (decision.toNotify.length > 0) {
            applyCards(enqueueNotifications(cardsRef.current, decision.toNotify));
          }
        }
      } catch {
        // 轮询失败静默：下一轮再试（任务契约失败与回滚）
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [applyCards]);

  /** × 关闭：仅移除该卡，队首补位 */
  const onDismiss = useCallback(
    (item: ScoreNotificationItem) => {
      applyCards(dismissNotification(cardsRef.current, notificationKey(item)));
    },
    [applyCards],
  );

  /** 主按钮：跳转该会话反馈页并关闭该卡（弹出时已标记已通知） */
  const onJump = useCallback(
    (item: ScoreNotificationItem) => {
      onDismiss(item);
      router.push(feedbackPathFor(item.sessionId));
    },
    [onDismiss, router],
  );

  if (cards.visible.length === 0) return null;

  return (
    <div className="pointer-events-none fixed top-4 right-4 z-50 flex w-80 flex-col gap-3">
      {cards.visible.map((item) => (
        <div key={notificationKey(item)} className={`${CARD} pointer-events-auto p-5`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-bold text-[#0F172A]">
                {item.kind === "scored" ? "训练评分完成" : "评分遇到波动"}
              </p>
              <p className="mt-1 truncate text-xs leading-5 text-[#475569]">{item.caseTitle}</p>
            </div>
            <button
              type="button"
              aria-label="关闭通知"
              onClick={() => onDismiss(item)}
              className="shrink-0 px-1 text-lg leading-none text-[#94A3B8] transition-colors hover:text-[#475569]"
            >
              ×
            </button>
          </div>
          <div className="mt-4 flex justify-end">
            <button type="button" onClick={() => onJump(item)} className={PRIMARY_BTN}>
              {item.kind === "scored" ? "查看评分结果" : "点击查看"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
