import { describe, expect, it } from "vitest";

import { selectPackQuestions, type PackQuestionCandidate } from "./selection";

function question(id: string, difficulty: number, overrides: Partial<PackQuestionCandidate> = {}): PackQuestionCandidate {
  return { id, difficulty, abilityTags: ["问题定义"], kind: "daily", status: "published", ...overrides };
}

describe("selectPackQuestions", () => {
  it("选择同维、上架日常、未练的五道不同题，按基础二、中等二、挑战一排列", () => {
    const candidates = [
      question("c", 4), question("b2", 2), question("a2", 3), question("b1", 1), question("a1", 3),
      question("practiced", 1), question("draft", 1, { status: "draft" }),
      question("baseline", 1, { kind: "baseline" }), question("other", 1, { abilityTags: ["用户理解"] }),
    ];
    const before = structuredClone(candidates);
    const result = selectPackQuestions(candidates, "问题定义", new Set(["practiced"]));
    expect(result.map(item => [item.questionId, item.targetTier, item.actualTier, item.actualDifficulty, item.substituted])).toEqual([
      ["b1", "basic", "basic", 1, false], ["b2", "basic", "basic", 2, false],
      ["a1", "advanced", "advanced", 3, false], ["a2", "advanced", "advanced", 3, false],
      ["c", "challenge", "challenge", 4, false],
    ]);
    expect(candidates).toEqual(before);
  });

  it("优先全局最少邻层递补，且明确记录实际难度", () => {
    const candidates = [question("b1", 1), question("b2", 2), question("b3", 2), question("a1", 3), question("a2", 3)];
    const result = selectPackQuestions(candidates, "问题定义", new Set());
    expect(result.map(item => [item.targetTier, item.actualTier])).toEqual([
      ["basic", "basic"], ["basic", "basic"], ["advanced", "basic"], ["advanced", "advanced"], ["challenge", "advanced"],
    ]);
    expect(result.filter(item => item.substituted)).toHaveLength(2);
    expect(new Set(result.map(item => item.questionId)).size).toBe(5);
  });

  it("同一候选顺序变化时结果稳定，且重复题目不会占两个槽位", () => {
    const candidates = [question("a", 1), question("b", 2), question("c", 3), question("d", 3), question("e", 5), question("a", 1)];
    const first = selectPackQuestions(candidates, "问题定义", new Set());
    expect(selectPackQuestions([...candidates].reverse(), "问题定义", new Set())).toEqual(first);
    expect(new Set(first.map(item => item.questionId)).size).toBe(5);
  });

  it("过滤坏标签和无效难度，不足五道时明确拒绝", () => {
    const candidates = [
      question("a", 1), question("b", 2), question("c", 3), question("d", 4),
      question("bad-tags", 2, { abilityTags: "问题定义" }), question("bad-difficulty", 7),
    ];
    expect(() => selectPackQuestions(candidates, "问题定义", new Set())).toThrowError(/不足/);
  });
});
