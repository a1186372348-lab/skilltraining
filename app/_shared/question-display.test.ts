import { describe, expect, it } from "vitest";
import { displayCaseTitle, displayMainQuestion } from "./question-display";

const marker = "【合成V2:123e4567-e89b-42d3-a456-426614174000:123e4567-e89b-42d3-a456-426614174001】";

describe("题目展示", () => {
  it("转换合成题标题并保持序号可区分", () => {
    expect(displayCaseTitle("合成验收案例 daily-15")).toBe("合成日常案例 16");
    expect(displayCaseTitle("合成验收案例 baseline-0")).toBe("合成基线案例 1");
    expect(displayCaseTitle("合成验收案例 daily-0")).toBe("合成日常案例 1");
  });
  it("普通或相近标题原样保留", () => {
    for (const title of ["真实案例", "合成验收案例 daily-01", "合成验收案例 daily-15 补充", "合成验收案例 extra-1"]) {
      expect(displayCaseTitle(title)).toBe(title);
    }
  });
  it("仅去除完整开头标记并保留正文", () => {
    expect(displayMainQuestion(`${marker}如何验证？`)).toBe("如何验证？");
    expect(displayMainQuestion(`${marker}\n  如何验证？`)).toBe("\n  如何验证？");
  });
  it("保留空正文、不完整标记、非开头标记及普通题", () => {
    for (const question of [marker, `${marker}  `, "【合成V2:bad:id】问题", `引文${marker}问题`, "真实题目"]) {
      expect(displayMainQuestion(question)).toBe(question);
    }
  });
});
