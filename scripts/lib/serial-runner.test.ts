import { describe, expect, it } from "vitest";

import {
  runSerial,
  runSerialWithSampleRetry,
  type SerialRunConfig,
} from "./serial-runner";

// 串行跑批与遍内定向补跑编排单测（T28 切片 2 选项 A）：fake runner 注入，
// 零 AI 出网；覆盖 首轮失败→补跑成功→归并 / 补跑仍失败→计入失败数 / 关闭补跑 / 无失败不补跑。

interface FakeTask {
  id: string;
}

interface FakeResult {
  score: number;
}

function makeConfig(runner: (task: FakeTask) => Promise<FakeResult>): SerialRunConfig<FakeTask, FakeResult, { label: string; score: number; attempts: number }> {
  return {
    labelOf: (task) => task.id,
    run: async (task) => {
      const result = await runner(task);
      return { result, entry: { score: result.score } };
    },
    fromCache: (_task, entry) => ({ score: entry.score }),
    validate: (raw): raw is { label: string; score: number; attempts: number } =>
      typeof (raw as { label?: unknown })?.label === "string",
    logLine: () => "",
    sleep: () => Promise.resolve(), // 测试注入 no-op，避免真实退避等待
  };
}

const TASKS: FakeTask[] = [{ id: "B3#1" }, { id: "B5#1" }, { id: "B12#1" }];

describe("runSerial：基础串行跑批", () => {
  it("全部成功：results 全量、failures 空；单样本连续失败 3 次（1+2 重试）后计入 failures", async () => {
    const ok = await runSerial(makeConfig(async (task) => ({ score: task.id.length })), TASKS);
    expect(ok.results).toHaveLength(3);
    expect(ok.failures).toHaveLength(0);

    let calls = 0;
    const failOne = await runSerial(
      makeConfig(async (task) => {
        if (task.id === "B5#1") {
          calls += 1;
          throw new Error("网关超时");
        }
        return { score: 1 };
      }),
      TASKS,
    );
    expect(failOne.results.map((r) => r.task.id)).toEqual(["B3#1", "B12#1"]);
    expect(failOne.failures).toEqual([{ task: TASKS[1], error: "网关超时", attempts: 3 }]);
    expect(calls).toBe(3); // 1 + 2 次重试
  });
});

describe("runSerialWithSampleRetry：遍内定向补跑编排", () => {
  it("首轮失败 → 补跑成功 → 该样本并入结果、failures 归零（该遍可判过）", async () => {
    // B5#1 在首遍 3 次尝试全败（计数 ≤3 抛错），补跑中成功
    let b5Calls = 0;
    const runner = async (task: FakeTask): Promise<FakeResult> => {
      if (task.id === "B5#1") {
        b5Calls += 1;
        if (b5Calls <= 3) throw new Error("非法 JSON");
        return { score: 55 };
      }
      return { score: 90 };
    };
    const { merged } = await runSerialWithSampleRetry(makeConfig(runner), TASKS, true);
    expect(merged.results.map((r) => r.label)).toEqual(["B12#1", "B3#1", "B5#1"].sort((a, b) => a.localeCompare(b)));
    expect(merged.failures).toEqual([]);
    expect(merged.retriedSucceeded).toEqual([{ label: "B5#1", firstError: "非法 JSON" }]);
    expect(b5Calls).toBe(4); // 首遍 3 次 + 补跑 1 次
  });

  it("补跑仍失败 → 计入 failures（错误原因为补跑后的）", async () => {
    const runner = async (task: FakeTask): Promise<FakeResult> => {
      if (task.id === "B5#1") throw new Error("持续失败");
      return { score: 90 };
    };
    const { merged } = await runSerialWithSampleRetry(makeConfig(runner), TASKS, true);
    expect(merged.results.map((r) => r.label)).toEqual(["B12#1", "B3#1"].sort((a, b) => a.localeCompare(b)));
    expect(merged.failures).toEqual([{ label: "B5#1", error: "持续失败" }]);
    expect(merged.retriedSucceeded).toEqual([]);
  });

  it("sampleRetryEnabled=false：不补跑，首遍失败原样计入", async () => {
    let b5Calls = 0;
    const runner = async (task: FakeTask): Promise<FakeResult> => {
      if (task.id === "B5#1") {
        b5Calls += 1;
        throw new Error("持续失败");
      }
      return { score: 90 };
    };
    const { merged } = await runSerialWithSampleRetry(makeConfig(runner), TASKS, false);
    expect(b5Calls).toBe(3); // 仅首遍 3 次，未触发补跑
    expect(merged.failures).toEqual([{ label: "B5#1", error: "持续失败" }]);
    expect(merged.retriedSucceeded).toEqual([]);
  });

  it("首遍无失败：不触发补跑（runner 调用数 = 样本数）", async () => {
    let calls = 0;
    const runner = async (task: FakeTask): Promise<FakeResult> => {
      calls += 1;
      return { score: task.id.length };
    };
    const { merged } = await runSerialWithSampleRetry(makeConfig(runner), TASKS, true);
    expect(calls).toBe(3);
    expect(merged.failures).toEqual([]);
    expect(merged.retriedSucceeded).toEqual([]);
  });
});
