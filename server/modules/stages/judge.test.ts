import { describe, expect, it } from "vitest";
import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";
import {
  judgeRetestTrigger, judgeRetestResult, resolveDimensionStage, resolveGlobalStage, selectInitialLegacyWindow,
  type StageObservation,
} from "./judge";

function observation(sequence: number, value: unknown, overrides: Partial<StageObservation> = {}): StageObservation {
  return {
    sessionId: `session-${sequence}`, dimension: "问题定义", sequence: BigInt(sequence),
    scoredAt: new Date(`2026-11-03T00:00:${String(sequence).padStart(2, "0")}Z`),
    sourceType: "daily", state: "scored", effectiveScores: [value], ...overrides,
  };
}

function run(observations: readonly StageObservation[], pending = false, afterSequence: bigint | null = null, legacyWindow: readonly StageObservation[] | null = null) {
  return judgeRetestTrigger({ dimension: "问题定义", observations, pending, afterSequence, legacyWindow });
}

describe("复测触发规则", () => {
  it("恰好三次有效分 ≥75，daily/extra/plan/pack 可组合，返回可持久化的三个会话", () => {
    const rows = [observation(1, 75, { sourceType: "extra" }), observation(2, 80, { sourceType: "plan" }), observation(3, 75, { sourceType: "pack" })];
    const original = structuredClone(rows);
    expect(run(rows)).toMatchObject({ status: "trigger", consecutive: 3, qualifying: [
      { sessionId: "session-1", effectiveScore: 75 }, { sessionId: "session-2", effectiveScore: 80 }, { sessionId: "session-3", effectiveScore: 75 },
    ] });
    expect(rows).toEqual(original);
  });

  it("中断后重新连续三次才触发，74.99 与两次成绩都不足", () => {
    expect(run([observation(1, 75), observation(2, 74.99), observation(3, 75), observation(4, 75)])).toMatchObject({ status: "waiting", consecutive: 2 });
    expect(run([observation(1, 75), observation(2, 60), observation(3, 75), observation(4, 75), observation(5, 75)])).toMatchObject({ status: "trigger", qualifying: [
      { sessionId: "session-3" }, { sessionId: "session-4" }, { sessionId: "session-5" },
    ] });
    expect(run([observation(1, 75), observation(2, 75)])).toMatchObject({ status: "waiting", consecutive: 2 });
  });

  it("只统计目标维、已评分、指定四种来源，基线和复测不会中断也不会凑数", () => {
    const rows = [observation(1, 75), observation(2, 5, { sourceType: "baseline" }), observation(3, 5, { sourceType: "retest" }),
      observation(4, 75, { dimension: "用户理解" }), observation(5, 75, { state: "followup" }), observation(6, 75)];
    expect(run(rows)).toMatchObject({ status: "waiting", consecutive: 2 });
    expect(run([...rows, observation(7, 75, { sourceType: "plan" })])).toMatchObject({ status: "trigger", consecutive: 3 });
  });

  it("每个会话每维只算一次：重复行不能凑数，完整重复不会破坏其他真实评分", () => {
    const one = observation(1, 75);
    expect(run([one, { ...one }, { ...one }])).toMatchObject({ status: "waiting", consecutive: 1 });
    expect(run([one, { ...one }, observation(2, 75), observation(3, 75)])).toMatchObject({ status: "trigger", consecutive: 3 });
  });

  it("缺失、重复、无效评分打断连续性，不能把两边拼成三次", () => {
    for (const values of [[], [80, 80], [null], [NaN], [Infinity], [-1], [101]]) {
      const rows = [observation(1, 80), observation(2, 80, { effectiveScores: values }), observation(3, 80), observation(4, 80)];
      expect(run(rows)).toMatchObject({ status: "waiting", consecutive: 2 });
    }
  });

  it("已有未决触发时不重复触发；结算边界前的三个成绩不可重复消费", () => {
    const rows = [observation(1, 80), observation(2, 80), observation(3, 80)];
    expect(run(rows, true)).toMatchObject({ status: "pending", consecutive: 0 });
    expect(run(rows, false, BigInt(3))).toMatchObject({ status: "waiting", consecutive: 0 });
    expect(run([...rows, observation(4, 75), observation(5, 75), observation(6, 75)], false, BigInt(3)))
      .toMatchObject({ status: "trigger", qualifying: [{ sessionId: "session-4" }, { sessionId: "session-5" }, { sessionId: "session-6" }] });
    const corruptOld = [...rows, observation(2, 80, { sessionId: "old-duplicate" })];
    expect(run([...corruptOld, observation(4, 75), observation(5, 75), observation(6, 75)], false, BigInt(3)))
      .toMatchObject({ status: "trigger", consecutive: 3 });
  });

  it("钩子漏执行后从水位恢复首个达标三连，即使后来追加低分", () => {
    const rows = [observation(1, 75), observation(2, 76), observation(3, 77), observation(4, 20)];
    expect(run(rows)).toMatchObject({ status: "trigger", qualifying: [{ sessionId: "session-1" }, { sessionId: "session-2" }, { sessionId: "session-3" }] });
  });

  it("首次初始化仅考察旧会话最近三次，已初始化后不反复回看旧会话", () => {
    const legacy = [75, 75, 75, 40, 75].map((value, index) => observation(index + 1, value, { sequence: null }));
    const selected = selectInitialLegacyWindow("问题定义", legacy);
    expect(selected.status).toBe("ready");
    expect(selected.window.map(row => row.sessionId)).toEqual(["session-3", "session-4", "session-5"]);
    expect(run([], false, null, selected.window)).toMatchObject({ status: "waiting", consecutive: 1 });
    expect(run(legacy)).toMatchObject({ status: "waiting", consecutive: 0 });
    const prior = selectInitialLegacyWindow("问题定义", [observation(1, 75, { sequence: null }), observation(2, 75, { sequence: null })]);
    expect(run([observation(3, 75, { sequence: BigInt(1) })], false, null, prior.window))
      .toMatchObject({ status: "trigger", qualifying: [{ sessionId: "session-1" }, { sessionId: "session-2" }, { sessionId: "session-3" }] });
    expect(run([], false, BigInt(0), prior.window)).toMatchObject({ status: "needs_recovery" });
  });

  it("旧窗口必须固定；窗口内历史会话丢失时中断连续性，不自动找更早成绩替补", () => {
    const history = [observation(1, 75, { sequence: null }), observation(2, 75, { sequence: null }), observation(3, 75, { sequence: null })];
    const selected = selectInitialLegacyWindow("问题定义", history);
    (history[1].effectiveScores as unknown[])[0] = 5;
    expect(selected.window[1].effectiveScores).toEqual([75]);
    const lost = selected.window.map((row, index) => index === 1 ? { ...row, effectiveScores: [] } : row);
    expect(run([observation(4, 75)], false, null, lost)).toMatchObject({ status: "waiting", consecutive: 2 });
  });

  it("新增评分按稳定提交序号排序，同刻和时钟回拨不影响顺序", () => {
    const time = new Date("2026-11-03T00:00:00Z");
    const rows = [observation(3, 78, { scoredAt: new Date("2026-11-02T23:59:59Z") }), observation(1, 75, { scoredAt: time }), observation(2, 76, { scoredAt: time })];
    expect(run(rows)).toMatchObject({ status: "trigger", qualifying: [{ sessionId: "session-1" }, { sessionId: "session-2" }, { sessionId: "session-3" }] });
  });

  it("时序无法确定、同一会话矛盾或不同会话共享序号时停止并要求恢复", () => {
    expect(run([observation(1, 75), observation(2, 75, { scoredAt: new Date("invalid") })])).toMatchObject({ status: "needs_recovery" });
    expect(run([observation(1, 75), observation(1, 76)])).toMatchObject({ status: "needs_recovery" });
    expect(run([observation(1, 75), observation(1, 75, { sessionId: "other" })])).toMatchObject({ status: "needs_recovery" });
  });
});

describe("成长阶段与复测结果", () => {
  const complete = new Set<string>(ABILITY_DIMENSIONS);
  it("未知维度优先显示探索期，待复测维度状态单独保留", () => {
    const incomplete = new Set(ABILITY_DIMENSIONS.slice(0, 7));
    expect(resolveGlobalStage(incomplete, true)).toBe("exploration");
    expect(resolveGlobalStage(new Set(), false)).toBe("exploration");
    expect(resolveDimensionStage("retest_trigger", false)).toBe("suspended");
    expect(resolveDimensionStage("retest_trigger", true)).toBe("pending");
  });

  it("八维完整时，有待决复测是复测期，否则为强化期", () => {
    expect(resolveGlobalStage(complete, true)).toBe("retest");
    expect(resolveGlobalStage(complete, false)).toBe("strengthening");
  });

  it("复测 60 通过，59.99 未通过，缺失或坏分不得判为失败或通过", () => {
    expect(judgeRetestResult(60)).toBe("pass");
    expect(judgeRetestResult(59.99)).toBe("fail");
    expect(judgeRetestResult(0)).toBe("fail");
    for (const bad of [null, NaN, Infinity, -1, 101, "60"]) expect(judgeRetestResult(bad)).toBeNull();
    expect(resolveDimensionStage("retest_pass", false)).toBe("verified");
    expect(resolveDimensionStage("retest_fail", true)).toBe("needs_practice");
    expect(resolveDimensionStage(null, true)).toBe("unverified");
  });
});
