import { describe, expect, it } from "vitest";

import {
  ABILITY_DIMENSION_COUNT,
  HINT_TREE_LAYERS,
  isValidHintLayer,
} from "./scaffold-smoke";

// 冒烟测试：验证 test 管线工作，并锚定 PRD 锁定常量
describe("脚手架冒烟示例", () => {
  it("能力画像为 8 个一级维度", () => {
    expect(ABILITY_DIMENSION_COUNT).toBe(8);
  });

  it("提示树固定 5 层", () => {
    expect(HINT_TREE_LAYERS).toBe(5);
  });

  it("提示层级仅接受 1~5 的整数", () => {
    expect(isValidHintLayer(1)).toBe(true);
    expect(isValidHintLayer(5)).toBe(true);
    expect(isValidHintLayer(0)).toBe(false);
    expect(isValidHintLayer(6)).toBe(false);
    expect(isValidHintLayer(1.5)).toBe(false);
  });
});
