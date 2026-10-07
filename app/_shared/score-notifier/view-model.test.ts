import { describe, expect, it } from "vitest";

import {
  FIRST_LOAD_SILENCE_MS,
  MAX_NOTIFIED_KEYS,
  MAX_VISIBLE_NOTIFICATIONS,
  appendNotifiedKeys,
  decideNotifications,
  dismissNotification,
  enqueueNotifications,
  feedbackPathFor,
  notificationKey,
  parseStoredKeys,
  type ScoreNotificationItem,
} from "./view-model";

// 评分完成全局通知 view-model 纯函数测试（T24 / Prd.md D26）。
// 覆盖任务契约全部决策规则：去重键 sessionId:kind、同会话双键各自可弹、
// 首载 30 分钟静默、反馈页路径抑制（标记不弹不响）、同屏 3 条排队补位、
// localStorage 键上限 50 条 FIFO、持久化数据防御解析。

const NOW = Date.parse("2026-10-07T12:00:00.000Z");

function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function makeItem(overrides: Partial<ScoreNotificationItem> = {}): ScoreNotificationItem {
  return {
    sessionId: "s-1",
    caseTitle: "案例一",
    kind: "scored",
    occurredAt: minutesAgo(1),
    ...overrides,
  };
}

function decideInput(overrides: Partial<Parameters<typeof decideNotifications>[0]> = {}) {
  return {
    items: [] as ScoreNotificationItem[],
    notifiedKeys: [] as string[],
    pathname: "/",
    nowMs: NOW,
    hasStoredKeys: true,
    ...overrides,
  };
}

describe("常量与基础函数", () => {
  it("决策常量：同屏 3 条、已通知键 50 条、首载静默 30 分钟", () => {
    expect(MAX_VISIBLE_NOTIFICATIONS).toBe(3);
    expect(MAX_NOTIFIED_KEYS).toBe(50);
    expect(FIRST_LOAD_SILENCE_MS).toBe(30 * 60 * 1000);
  });

  it("去重键为 ${sessionId}:${kind}（D26④）", () => {
    expect(notificationKey({ sessionId: "s-1", kind: "scored" })).toBe("s-1:scored");
    expect(notificationKey({ sessionId: "s-1", kind: "stuck" })).toBe("s-1:stuck");
  });

  it("反馈页路径：/training/feedback/{sessionId}（T25 迁入产品训练模块）", () => {
    expect(feedbackPathFor("s-1")).toBe("/training/feedback/s-1");
  });
});

describe("decideNotifications：去重规则", () => {
  it("已通知键再次出现：不弹也不再标记", () => {
    const result = decideNotifications(
      decideInput({
        items: [makeItem()],
        notifiedKeys: ["s-1:scored"],
      }),
    );
    expect(result.toNotify).toEqual([]);
    expect(result.keysToMark).toEqual([]);
  });

  it("同会话 scored 与 stuck 是两个键：scored 已弹过，stuck 仍可弹", () => {
    const stuck = makeItem({ kind: "stuck", occurredAt: minutesAgo(6) });
    const result = decideNotifications(
      decideInput({ items: [stuck], notifiedKeys: ["s-1:scored"] }),
    );
    expect(result.toNotify).toEqual([stuck]);
    expect(result.keysToMark).toEqual(["s-1:stuck"]);
  });

  it("多个新通知按输入顺序全部弹出并标记", () => {
    const a = makeItem({ sessionId: "s-1" });
    const b = makeItem({ sessionId: "s-2", kind: "stuck" });
    const result = decideNotifications(decideInput({ items: [a, b] }));
    expect(result.toNotify).toEqual([a, b]);
    expect(result.keysToMark).toEqual(["s-1:scored", "s-2:stuck"]);
  });
});

describe("decideNotifications：首载静默规则（D26④ 防弹窗风暴）", () => {
  it("首次加载（无 localStorage 记录）：occurredAt 超 30 分钟的项静默标记不弹", () => {
    const old = makeItem({ occurredAt: minutesAgo(31) });
    const result = decideNotifications(
      decideInput({ items: [old], hasStoredKeys: false }),
    );
    expect(result.toNotify).toEqual([]);
    expect(result.keysToMark).toEqual(["s-1:scored"]);
  });

  it("首次加载：occurredAt 在 30 分钟内的项正常弹出", () => {
    const fresh = makeItem({ occurredAt: minutesAgo(29) });
    const result = decideNotifications(
      decideInput({ items: [fresh], hasStoredKeys: false }),
    );
    expect(result.toNotify).toEqual([fresh]);
    expect(result.keysToMark).toEqual(["s-1:scored"]);
  });

  it("非首次加载（记录已存在）：30 分钟前的项正常弹出（错过后的补弹一次）", () => {
    const old = makeItem({ occurredAt: minutesAgo(120) });
    const result = decideNotifications(
      decideInput({ items: [old], hasStoredKeys: true }),
    );
    expect(result.toNotify).toEqual([old]);
  });
});

describe("decideNotifications：反馈页抑制规则（D26③）", () => {
  it("当前路径是该会话反馈页：标记已通知但不弹不响（页面自身轮询原地出分）", () => {
    const fresh = makeItem({ occurredAt: minutesAgo(0) });
    const result = decideNotifications(
      decideInput({ items: [fresh], pathname: "/training/feedback/s-1" }),
    );
    expect(result.toNotify).toEqual([]);
    expect(result.keysToMark).toEqual(["s-1:scored"]);
  });

  it("其他会话的反馈页不抑制：正常弹出", () => {
    const fresh = makeItem({ sessionId: "s-1" });
    const result = decideNotifications(
      decideInput({ items: [fresh], pathname: "/training/feedback/s-2" }),
    );
    expect(result.toNotify).toEqual([fresh]);
  });

  it("其余任意页面均弹出", () => {
    for (const pathname of ["/", "/training", "/profile", "/training/session/s-9"]) {
      const fresh = makeItem();
      const result = decideNotifications(decideInput({ items: [fresh], pathname }));
      expect(result.toNotify).toEqual([fresh]);
    }
  });
});

describe("appendNotifiedKeys：localStorage 已通知键（上限 50 条 FIFO）", () => {
  it("追加并去重（同键不重复占位的，原位置保持不变）", () => {
    expect(appendNotifiedKeys(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("超过 50 条时按 FIFO 截断：最早的键被挤出，最新键保留在尾部", () => {
    const existing = Array.from({ length: 50 }, (_, i) => `k-${i}`);
    const next = appendNotifiedKeys(existing, ["k-new-1", "k-new-2"]);
    expect(next).toHaveLength(50);
    expect(next[0]).toBe("k-2");
    expect(next[49]).toBe("k-new-2");
  });
});

describe("parseStoredKeys：持久化数据防御解析", () => {
  it("null（从未写入）：无记录，触发首载静默规则", () => {
    expect(parseStoredKeys(null)).toEqual({ keys: [], hasStoredKeys: false });
  });

  it("非法 JSON / 非数组 / 含非字符串项：按无记录处理，不污染决策", () => {
    expect(parseStoredKeys("not-json").hasStoredKeys).toBe(false);
    expect(parseStoredKeys('{"a":1}').hasStoredKeys).toBe(false);
    expect(parseStoredKeys('["a", 1, null]').hasStoredKeys).toBe(false);
  });

  it("合法数组（含空数组）：记录已建立，不再适用首载静默", () => {
    expect(parseStoredKeys('["a","b"]')).toEqual({ keys: ["a", "b"], hasStoredKeys: true });
    expect(parseStoredKeys("[]")).toEqual({ keys: [], hasStoredKeys: true });
  });
});

describe("通知队列：同屏至多 3 条、关闭后补位（任务契约）", () => {
  const items = ["s-1", "s-2", "s-3", "s-4"].map((sessionId) => makeItem({ sessionId }));

  it("4 条新通知进入空队列：可见 3 条、排队 1 条", () => {
    const next = enqueueNotifications({ visible: [], queue: [] }, items);
    expect(next.visible).toEqual(items.slice(0, 3));
    expect(next.queue).toEqual([items[3]]);
  });

  it("可见位占满时新通知一律排队", () => {
    const state = { visible: items.slice(0, 3), queue: [] as ScoreNotificationItem[] };
    const next = enqueueNotifications(state, [items[3]]);
    expect(next.visible).toEqual(items.slice(0, 3));
    expect(next.queue).toEqual([items[3]]);
  });

  it("关闭一张可见卡：队首补位，其余排队不变", () => {
    const state = { visible: items.slice(0, 3), queue: [items[3]] };
    const next = dismissNotification(state, "s-2:scored");
    expect(next.visible).toEqual([items[0], items[2], items[3]]);
    expect(next.queue).toEqual([]);
  });

  it("关闭不存在的键：状态原样返回", () => {
    const state = { visible: items.slice(0, 2), queue: [] as ScoreNotificationItem[] };
    expect(dismissNotification(state, "s-x:scored")).toEqual(state);
  });
});
