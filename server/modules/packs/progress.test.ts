import { describe, expect, it } from "vitest";

import { derivePackProgress, type PackProgressItem } from "./progress";

function item(orderIndex: number, overrides: Partial<PackProgressItem> = {}): PackProgressItem {
  return { orderIndex, unlockedAt: orderIndex === 0 ? new Date("2026-10-01T00:00:00Z") : null, startedAt: overrides.session ? new Date("2026-10-01T00:30:00Z") : null, session: null, ...overrides };
}

function scored(value: number | null = 70): PackProgressItem["session"] {
  return { id: "session", state: "scored", finalSubmittedAt: new Date("2026-10-01T01:00:00Z"), scoredAt: new Date("2026-10-01T01:01:00Z"), scores: value === null ? [] : [{ dimension: "问题定义", effectiveScore: value }] };
}

describe("derivePackProgress", () => {
  it("新包只允许第一题开始", () => {
    const result = derivePackProgress("active", "问题定义", Array.from({ length: 5 }, (_, i) => item(i)));
    expect(result.items.map(row => row.state)).toEqual(["available", "locked", "locked", "locked", "locked"]);
    expect(result.nextUnlockIndex).toBeNull();
    expect(result.completedCount).toBe(0);
  });

  it("评分完成才解锁下一题，重复计算不重复推进", () => {
    const source = [item(0, { session: scored(0) }), item(1), item(2), item(3), item(4)];
    const result = derivePackProgress("active", "问题定义", source);
    expect(result.items[0].state).toBe("scored");
    expect(result.nextUnlockIndex).toBe(1);
    expect(result.completedCount).toBe(1);
    const updated = source.map(row => row.orderIndex === 1 ? { ...row, unlockedAt: new Date("2026-10-01T02:00:00Z") } : row);
    expect(derivePackProgress("active", "问题定义", updated).nextUnlockIndex).toBeNull();
  });

  it("已终答待评分和缺失目标维评分都不能越级", () => {
    const pending = item(0, { session: { id: "s", state: "followup", finalSubmittedAt: new Date(), scoredAt: null, scores: [] } });
    expect(derivePackProgress("active", "问题定义", [pending, item(1)]).items[0].state).toBe("awaiting_score");
    expect(derivePackProgress("active", "问题定义", [pending, item(1)]).nextUnlockIndex).toBeNull();
    const malformed = item(0, { session: scored(null) });
    expect(derivePackProgress("active", "问题定义", [malformed, item(1)]).items[0].state).toBe("inconsistent");
    expect(derivePackProgress("active", "问题定义", [malformed, item(1)]).nextUnlockIndex).toBeNull();
  });

  it("全部评分才完成；放弃或完成后不再解锁", () => {
    const all = Array.from({ length: 5 }, (_, i) => item(i, { unlockedAt: new Date(), session: scored(70 + i) }));
    expect(derivePackProgress("active", "问题定义", all).shouldComplete).toBe(true);
    expect(derivePackProgress("completed", "问题定义", all).shouldComplete).toBe(false);
    const partial = [item(0, { session: scored() }), item(1)];
    expect(derivePackProgress("abandoned", "问题定义", partial).nextUnlockIndex).toBeNull();
    expect(derivePackProgress("completed", "问题定义", partial).nextUnlockIndex).toBeNull();
  });

  it("允许根据已落库评分恢复连续进度，并按顺序而非传入数组排列", () => {
    const rows = [item(4), item(2), item(1, { unlockedAt: new Date(), session: scored(81) }), item(0, { session: scored(80) }), item(3)];
    const result = derivePackProgress("active", "问题定义", rows);
    expect(result.items.map(row => row.orderIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(result.nextUnlockIndex).toBe(2);
  });

  it("持久化条目不满五条或超过五条时绝不自动解锁", () => {
    const four = [item(0, { session: scored() }), item(1), item(2), item(3)];
    const six = [...four, item(4), item(5)];
    for (const rows of [four, six]) {
      const progress = derivePackProgress("active", "问题定义", rows);
      expect(progress.nextUnlockIndex).toBeNull();
      expect(progress.shouldComplete).toBe(false);
    }
  });

  it("已开始却丢失会话、会话缺失开始标记或单题被终止时明确待恢复", () => {
    const lost = item(0, { startedAt: new Date(), session: null });
    const noMarker = item(0, { startedAt: null, session: scored() });
    const abandoned = item(0, { session: { id: "s", state: "abandoned", finalSubmittedAt: null, scoredAt: null, scores: [] } });
    for (const row of [lost, noMarker, abandoned]) {
      const progress = derivePackProgress("active", "问题定义", [row, item(1)]);
      expect(progress.items[0].state).toBe("inconsistent");
      expect(progress.nextUnlockIndex).toBeNull();
    }
  });

  it("整包已确认放弃时，被同步终止的当前会话显示不可用而不是数据损坏", () => {
    const abandoned = item(0, { session: { id: "s", state: "abandoned", finalSubmittedAt: null, scoredAt: null, scores: [] } });
    const progress = derivePackProgress("abandoned", "问题定义", [abandoned, item(1), item(2), item(3), item(4)]);
    expect(progress.items[0].state).toBe("unavailable");
    expect(progress.nextUnlockIndex).toBeNull();
  });

  it("顺序损坏或后续题意外解锁时不自动推进任何题", () => {
    const broken = [item(0, { session: scored() }), item(1), item(2, { unlockedAt: new Date() })];
    const duplicate = [item(0, { session: scored() }), item(1), item(1)];
    for (const rows of [broken, duplicate]) {
      const progress = derivePackProgress("active", "问题定义", rows);
      expect(progress.items.some(row => row.state === "inconsistent")).toBe(true);
      expect(progress.nextUnlockIndex).toBeNull();
    }
  });
});
