import { describe, expect, it } from "vitest";

import { independenceCoefficient } from "./coefficient";

// BR-2：独立完成系数 = max(0.6, 1 − 0.1 × 首次提交前的提示次数)
// 对照表：0 次=1.0，1 次=0.9，2 次=0.8，3 次=0.7，≥4 次=0.6
describe("independenceCoefficient（BR-2 独立完成系数）", () => {
  it("0 次提示：1.0", () => {
    expect(independenceCoefficient(0)).toBe(1.0);
  });

  it("1 次提示：0.9", () => {
    expect(independenceCoefficient(1)).toBe(0.9);
  });

  it("2 次提示：0.8", () => {
    expect(independenceCoefficient(2)).toBe(0.8);
  });

  it("3 次提示：0.7（浮点安全）", () => {
    expect(independenceCoefficient(3)).toBe(0.7);
  });

  it("4 次提示：0.6（到达下限）", () => {
    expect(independenceCoefficient(4)).toBe(0.6);
  });

  it("5 次及以上：保持 0.6 下限", () => {
    expect(independenceCoefficient(5)).toBe(0.6);
    expect(independenceCoefficient(10)).toBe(0.6);
  });

  it("异常负数输入按 0 次处理", () => {
    expect(independenceCoefficient(-1)).toBe(1.0);
  });

  it("非有限输入按 0 次处理；小数向下取整", () => {
    expect(independenceCoefficient(Number.NaN)).toBe(1.0);
    expect(independenceCoefficient(1.9)).toBe(0.9);
  });
});
