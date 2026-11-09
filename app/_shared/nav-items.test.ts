import { describe, expect, it } from "vitest";

import { navItemsFor, type NavLabel } from "./nav-items";

// 成长阶段作为固定入口，所有页面保持相同导航顺序。
const FIXED_ORDER: ReadonlyArray<readonly [NavLabel, string]> = [
  ["首页", "/"],
  ["产品训练", "/training"],
  ["能力画像", "/profile"],
  ["成长阶段" as NavLabel, "/stages"],
  ["我的", "/settings"],
];

describe("navItemsFor", () => {
  it("无论当前页是哪个，顺序始终固定", () => {
    for (const [label] of FIXED_ORDER) {
      const items = navItemsFor(label);
      expect(items.map((item) => [item.label, item.href])).toEqual([...FIXED_ORDER]);
    }
  });

  it("恰好一项被标记为 active，且与传入标签一致", () => {
    for (const [label] of FIXED_ORDER) {
      const items = navItemsFor(label);
      const actives = items.filter((item) => item.active);
      expect(actives).toHaveLength(1);
      expect(actives[0].label).toBe(label);
    }
  });
});
