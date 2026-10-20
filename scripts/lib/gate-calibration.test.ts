import { describe, expect, it } from "vitest";

import {
  analyzeGateComparison,
  buildBlindReviewMarkdown,
  buildGateSampleTasks,
  createMockGateRunner,
  formatGateConsoleSummary,
  formatGateMarkdownReport,
  gateSampleLabel,
  parseGateHumanReview,
  type GateMachineResult,
} from "./gate-calibration";

// 追问闸门人审校准纯逻辑测试：fixtures 驱动，严禁真实 AI 调用。
// 指标口径（与产品负责人锁定）：
// - 放水：人审该追问（followup）且机器判跳过（skip）——须趋近 0；
// - 误伤：人审不该追问（skip）且机器判追问（followup）——阈值人审裁定；
// - 灰区：人审 gray 单独统计机器判定分布，不进一致率/放水/误伤。

const questionB3 = {
  id: "B3",
  title: "淘宝担保交易",
  main_question: "2003 年淘宝最该优先解决的问题是什么？",
  ability_tags: ["问题定义", "用户理解"],
  rubric: { dimensions: { 问题定义: ["要点1"] }, forbidden_leaks: ["绝密结论"] },
} as never;

const questionB5 = {
  id: "B5",
  title: "网易云音乐歌单",
  main_question: "歌单功能解决了什么问题？",
  ability_tags: ["用户理解"],
  rubric: { dimensions: { 用户理解: ["要点1"] }, forbidden_leaks: [] },
} as never;

const answersB3 = [
  { text: "首答一：对象场景差距边界依据齐备。", quality: "high", note: "立场A高质量 ｜ 人审 92 分" },
  { text: "首答二：流畅但依据不足。", quality: "low", note: "低分锚点 ｜ 人审 12 分" },
  { text: "首答三：中等质量。", quality: "medium", note: "中间档 ｜ 人审 65 分" },
] as never;

const answersB5 = [
  { text: "首答四：完整作答。", quality: "high", note: "人审 88 分" },
  { text: "首答五：缺证据。", quality: "low", note: "人审 20 分" },
] as never;

const reviewB3 = {
  mainDimension: "问题定义",
  samples: [
    { sampleIndex: 1, blindId: "S1", humanScore: 92 },
    { sampleIndex: 2, blindId: "S2", humanScore: 12 },
    { sampleIndex: 3, blindId: "S3", humanScore: 65 },
  ],
};

const reviewB5 = {
  mainDimension: "用户理解",
  samples: [
    { sampleIndex: 1, blindId: "S1", humanScore: 88 },
    { sampleIndex: 2, blindId: "S2", humanScore: 20 },
  ],
};

function makeTasks() {
  return [
    ...buildGateSampleTasks(questionB3, answersB3, reviewB3),
    ...buildGateSampleTasks(questionB5, answersB5, reviewB5),
  ];
}

function makeResult(
  taskIndex: number,
  shouldFollowup: boolean,
  tasks = makeTasks(),
): GateMachineResult {
  return {
    task: tasks[taskIndex],
    shouldFollowup,
    reason: `机器理由${taskIndex + 1}`,
    followupCount: shouldFollowup ? 2 : 0,
    latencyMs: 1000 + taskIndex,
    attempts: 1,
  };
}

describe("buildGateSampleTasks：样本任务构造", () => {
  it("主测维度取 ability_tags[0]，首答映射为 FollowupInput，blindId/humanScore 从人审映射带入", () => {
    const tasks = makeTasks();
    expect(tasks).toHaveLength(5);
    expect(tasks[0].input.primaryDimension).toBe("问题定义");
    expect(tasks[0].input.mainQuestion).toContain("2003 年淘宝");
    expect(tasks[0].input.firstAnswer).toContain("首答一");
    expect(tasks[0].input.rubric.forbidden_leaks).toEqual(["绝密结论"]);
    expect(tasks[0].blindId).toBe("S1");
    expect(tasks[0].humanScore).toBe(92);
    expect(gateSampleLabel(tasks[0])).toBe("B3#1");
    expect(tasks[3].input.primaryDimension).toBe("用户理解"); // B5 首标签
  });

  it("样本在人审映射中缺失时报错（映射不完整不可盲评）", () => {
    const broken = { ...reviewB3, samples: reviewB3.samples.slice(0, 2) };
    expect(() => buildGateSampleTasks(questionB3, answersB3, broken)).toThrow(/B3#3|映射/);
  });
});

describe("parseGateHumanReview：人审判定文件解析与校验", () => {
  const validJson = JSON.stringify({
    B3: { S1: "followup", S2: "followup", S3: "gray" },
    B5: { S1: "skip", S2: "followup" },
  });

  it("合法文件解析为题号 → blindId → 判定", () => {
    const parsed = parseGateHumanReview(validJson, makeTasks());
    expect(parsed.B3.S1).toBe("followup");
    expect(parsed.B3.S3).toBe("gray");
    expect(parsed.B5.S2).toBe("followup");
  });

  it("非合法 JSON：可读报错", () => {
    expect(() => parseGateHumanReview("{oops", makeTasks())).toThrow(/不是合法 JSON/);
  });

  it("非法判定值：报错指出位置与值域", () => {
    const bad = JSON.stringify({ B3: { S1: "yes", S2: "followup", S3: "gray" }, B5: { S1: "skip", S2: "followup" } });
    expect(() => parseGateHumanReview(bad, makeTasks())).toThrow(/B3.*S1|S1.*B3/);
    expect(() => parseGateHumanReview(bad, makeTasks())).toThrow(/followup.*skip.*gray/);
  });

  it("未知题号 / 未知样本编号：可读报错", () => {
    const unknownQ = JSON.stringify({ B99: { S1: "skip" }, B3: { S1: "followup", S2: "followup", S3: "gray" }, B5: { S1: "skip", S2: "followup" } });
    expect(() => parseGateHumanReview(unknownQ, makeTasks())).toThrow(/B99/);
    const unknownS = JSON.stringify({ B3: { S1: "followup", S2: "followup", S3: "gray", S9: "skip" }, B5: { S1: "skip", S2: "followup" } });
    expect(() => parseGateHumanReview(unknownS, makeTasks())).toThrow(/S9/);
  });

  it("缺样本判定：报错列出缺失项（对照要求人审覆盖全部样本）", () => {
    const missing = JSON.stringify({ B3: { S1: "followup", S2: "followup" }, B5: { S1: "skip", S2: "followup" } });
    expect(() => parseGateHumanReview(missing, makeTasks())).toThrow(/B3.*S3|S3/);
    expect(() => parseGateHumanReview(missing, makeTasks())).toThrow(/缺|未覆盖/);
  });
});

describe("analyzeGateComparison：对照指标", () => {
  // 机器判定分布：B3#1 追问 / B3#2 追问 / B3#3 跳过 / B5#1 跳过 / B5#2 跳过
  // 人审：B3 S1 followup / S2 followup / S3 gray；B5 S1 skip / S2 followup
  // → 一致 2（B3#1、B5#2）/ 放水 1（B5#1：人审 skip… 不对，见下）
  // 精确：B3#1 人审 followup+机器 followup=一致；B3#2 人审 followup+机器 followup=一致；
  //       B5#1 人审 skip+机器 skip=一致；B5#2 人审 followup+机器 skip=放水；B3#3 灰区（机器 skip）
  function makeComparisonInputs() {
    const tasks = makeTasks();
    const results = [
      makeResult(0, true, tasks),
      makeResult(1, true, tasks),
      makeResult(2, false, tasks),
      makeResult(3, false, tasks),
      makeResult(4, false, tasks),
    ];
    const human = parseGateHumanReview(
      JSON.stringify({
        B3: { S1: "followup", S2: "followup", S3: "gray" },
        B5: { S1: "skip", S2: "followup" },
      }),
      tasks,
    );
    return { results, human, tasks };
  }

  it("逐行结论：一致/放水/误伤/灰区判定式正确", () => {
    const { rows } = analyzeGateComparison(makeComparisonInputs());
    expect(rows.map((r) => r.outcome)).toEqual(["agree", "agree", "gray", "agree", "miss"]);
    const miss = rows.find((r) => r.outcome === "miss")!;
    expect(miss.questionId).toBe("B5");
    expect(miss.blindId).toBe("S2"); // B5#2 → blindId S2：人审该追问、机器判跳过 = 放水
    expect(miss.reason).toBe("机器理由5");
  });

  it("指标：一致率 / 放水率 / 误伤率 / 灰区分布（灰区不进一致率与两项率）", () => {
    const { metrics } = analyzeGateComparison(makeComparisonInputs());
    expect(metrics.comparedCount).toBe(4); // 灰区不进分母
    expect(metrics.agreeCount).toBe(3);
    expect(metrics.agreeRate).toBeCloseTo(0.75);
    expect(metrics.missCount).toBe(1); // 放水
    expect(metrics.humanFollowupCount).toBe(3);
    expect(metrics.missRate).toBeCloseTo(1 / 3);
    expect(metrics.harmCount).toBe(0); // 误伤
    expect(metrics.humanSkipCount).toBe(1);
    expect(metrics.harmRate).toBe(0);
    expect(metrics.grayCount).toBe(1);
    expect(metrics.grayMachineSkip).toBe(1);
    expect(metrics.grayMachineFollowup).toBe(0);
    expect(metrics.machineFollowupCount).toBe(2); // 全样本机器分布（含灰区）
    expect(metrics.machineSkipCount).toBe(3);
  });

  it("误伤判定：人审 skip 且机器 followup 计入 harm", () => {
    const tasks = makeTasks();
    const results = [
      makeResult(0, true, tasks),
      makeResult(1, true, tasks),
      makeResult(2, false, tasks),
      makeResult(3, true, tasks), // B5#1 人审 skip、机器 followup → 误伤
      makeResult(4, false, tasks),
    ];
    const human = parseGateHumanReview(
      JSON.stringify({
        B3: { S1: "followup", S2: "followup", S3: "gray" },
        B5: { S1: "skip", S2: "followup" },
      }),
      tasks,
    );
    const { rows, metrics } = analyzeGateComparison({ results, human, tasks });
    expect(rows[3].outcome).toBe("harm");
    expect(metrics.harmCount).toBe(1);
    expect(metrics.harmRate).toBeCloseTo(1);
  });

  it("机器结果缺失的样本单独列出（提示 --only 补跑），不进对照指标", () => {
    const tasks = makeTasks();
    const results = [makeResult(0, true, tasks)]; // 只有 1 份机器结果
    const human = parseGateHumanReview(
      JSON.stringify({
        B3: { S1: "followup", S2: "followup", S3: "gray" },
        B5: { S1: "skip", S2: "followup" },
      }),
      tasks,
    );
    const { rows, metrics, missingMachine } = analyzeGateComparison({ results, human, tasks });
    expect(rows).toHaveLength(1);
    expect(metrics.comparedCount).toBe(1);
    expect(missingMachine.map(gateSampleLabel)).toEqual(["B3#2", "B3#3", "B5#1", "B5#2"]);
  });
});

describe("buildBlindReviewMarkdown：盲评材料（无任何质量锚点）", () => {
  it("按题分组、blindId 标注、判定留白，且不出现 quality/note/humanScore 等锚点", () => {
    const markdown = buildBlindReviewMarkdown(
      [
        {
          questionId: "B3",
          mainQuestion: "2003 年淘宝最该优先解决的问题是什么？",
          mainDimension: "问题定义",
          samples: [
            { blindId: "S1", text: "首答一全文" },
            { blindId: "S2", text: "首答二全文" },
          ],
        },
      ],
      new Date("2026-10-19T10:00:00Z"),
    );
    expect(markdown).toContain("该追问");
    expect(markdown).toContain("不该追问");
    expect(markdown).toContain("灰区");
    expect(markdown).toContain("判定留白");
    expect(markdown).toContain("S1");
    expect(markdown).toContain("首答一全文");
    expect(markdown).toContain("2003 年淘宝");
    expect(markdown).toContain("问题定义");
    // 盲评防线：质量锚点绝不出现
    expect(markdown).not.toMatch(/quality|humanScore/i);
    expect(markdown).not.toMatch(/\bhigh\b|\blow\b|\bmedium\b/);
  });

  it("头部评审指引：三值一词定义 + 逐题集中评审建议", () => {
    const markdown = buildBlindReviewMarkdown([], new Date());
    expect(markdown).toMatch(/评审指引/);
    expect(markdown).toMatch(/公允评分/);
    expect(markdown).toMatch(/逐题/);
  });
});

describe("createMockGateRunner：确定性桩（离线验证管线）", () => {
  it("同一输入恒定输出，不调用任何外部服务", async () => {
    const tasks = makeTasks();
    const runner = createMockGateRunner(tasks);
    const first = await runner(tasks[0].input);
    const second = await runner(tasks[0].input);
    expect(first).toEqual(second);
    expect(typeof first.shouldFollowup).toBe("boolean");
    expect(first.reason.length).toBeGreaterThan(0);
    if (first.shouldFollowup) {
      expect(first.followups.length).toBeGreaterThan(0);
    } else {
      expect(first.followups).toEqual([]);
    }
  });

  it("不同样本产生混合判定（管线能走到两个分支）", async () => {
    const tasks = makeTasks();
    const runner = createMockGateRunner(tasks);
    const outcomes = await Promise.all(tasks.map((t) => runner(t.input)));
    expect(outcomes.some((o) => o.shouldFollowup)).toBe(true);
    expect(outcomes.some((o) => !o.shouldFollowup)).toBe(true);
  });
});

describe("报告格式化（机器模式与对照模式）", () => {
  function makeParams() {
    const tasks = makeTasks();
    const results = [
      makeResult(0, true, tasks),
      makeResult(1, true, tasks),
      makeResult(2, false, tasks),
      makeResult(3, false, tasks),
      makeResult(4, false, tasks),
    ];
    const human = parseGateHumanReview(
      JSON.stringify({
        B3: { S1: "followup", S2: "followup", S3: "gray" },
        B5: { S1: "skip", S2: "followup" },
      }),
      tasks,
    );
    const comparison = analyzeGateComparison({ results, human, tasks });
    return {
      base: {
        mode: "live" as const,
        model: "deepseek-flash",
        generatedAt: new Date("2026-10-19T10:00:00Z"),
        results,
        failures: [{ task: tasks[1], error: "网关超时", attempts: 3 }],
        comparison: null,
      },
      compare: {
        mode: "compare" as const,
        model: "deepseek-flash",
        generatedAt: new Date("2026-10-19T10:00:00Z"),
        results,
        failures: [],
        comparison,
      },
    };
  }

  it("机器模式：分布汇总 + 失败清单 + 逐样本表（无对照段）", () => {
    const { base } = makeParams();
    const markdown = formatGateMarkdownReport(base);
    expect(markdown).toContain("追问 2 / 跳过 3");
    expect(markdown).toContain("网关超时");
    expect(markdown).toContain("B3#1");
    expect(markdown).toContain("机器理由1");
    expect(markdown).not.toContain("人审对照");
    const summary = formatGateConsoleSummary(base);
    expect(summary).toContain("追问 2 / 跳过 3");
    expect(summary).toContain("失败 1");
  });

  it("对照模式：对照表 + 指标区 + 结论区（放水达标线 + 误伤率留白）+ humanScore 参考列标注", () => {
    const { compare } = makeParams();
    const markdown = formatGateMarkdownReport(compare);
    expect(markdown).toContain("人审对照");
    expect(markdown).toContain("放水");
    expect(markdown).toContain("误伤");
    expect(markdown).toContain("灰区");
    // 指标数值：一致率 75.0%（3/4）、放水率 33.3%（1/3）、误伤率 0.0%（0/1）
    expect(markdown).toContain("75.0%");
    expect(markdown).toContain("33.3%");
    expect(markdown).toContain("0.0%");
    // humanScore 列标注仅为上下文
    expect(markdown).toMatch(/humanScore|人审总分/);
    expect(markdown).toMatch(/仅为上下文|不参与判定/);
    // 结论区：放水达标线 + 误伤率留白待裁定
    expect(markdown).toMatch(/达标线/);
    expect(markdown).toMatch(/待.*裁定|留空/);
    // 机器结果缺失清单（本例无缺失）
    expect(markdown).not.toContain("补跑");
  });
});
