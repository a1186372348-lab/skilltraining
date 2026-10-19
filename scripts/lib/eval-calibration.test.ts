// 基线 8 题校准纯函数单测：评分输入构造 / 分离度与立场、承认未知分析 / 三档结论 / mock 桩 / 报告格式化
import { describe, expect, it } from "vitest";

import type { QuestionContent } from "../../server/modules/content/question-schema.ts";
import type { RubricScoringOutput } from "../../server/modules/scoring/rubric-scorer.ts";
import {
  analyzeHumanAlignment,
  analyzeScores,
  buildSampleTasks,
  buildVerdict,
  createMockEvalScorer,
  formatConsoleSummary,
  formatMarkdownReport,
  HUMAN_NOISE_BAND,
  overallScore,
  scoreBand,
  SEPARATION_FAIL_GAP,
  SEPARATION_HEALTHY_GAP,
  STANCE_GAP_THRESHOLD,
  UNKNOWN_GAP_THRESHOLD,
  type EvalSampleTask,
  type HumanReviewData,
  type SampleFailure,
  type SampleScore,
} from "./eval-calibration.ts";

const DIMENSIONS = { 问题定义: ["标准1", "标准2", "标准3"], 用户理解: ["标准1", "标准2", "标准3"] };

function fakeQuestion(id: string): QuestionContent {
  return {
    id,
    title: `${id} 标题`,
    main_question: `${id} 主问题`,
    ability_tags: Object.keys(DIMENSIONS), // 首标签即主测维度（R3 约定）
    rubric: { dimensions: DIMENSIONS },
  } as unknown as QuestionContent;
}

function makeTask(questionId: string, sampleIndex: number, quality: "high" | "medium" | "low", note = ""): EvalSampleTask {
  return {
    questionId,
    questionTitle: `${questionId} 标题`,
    sampleIndex,
    quality,
    note,
    input: {
      mainDimension: "问题定义",
      mainQuestion: `${questionId} 主问题`,
      rubricDimensions: DIMENSIONS,
      firstAnswer: "样本正文",
      followupQuestions: [],
      finalAnswer: "样本正文",
    },
  };
}

function makeScore(task: EvalSampleTask, overall: number): SampleScore {
  return {
    task,
    output: {
      dimensions: Object.keys(DIMENSIONS).map((dimension) => ({
        dimension,
        rawScore: overall,
        diagnosis: `诊断 ${dimension}`,
      })),
      topIssue: "最需优化的问题",
      nextFocus: "下一步方向",
    },
    overall,
    attempts: 1,
  };
}

function fixture(params: {
  scores?: SampleScore[];
  failures?: SampleFailure[];
}) {
  const scores = params.scores ?? [];
  const failures = params.failures ?? [];
  const analysis = analyzeScores(scores);
  const verdict = buildVerdict(analysis, failures);
  return { scores, failures, analysis, verdict };
}

describe("buildSampleTasks", () => {
  it("样本文本同时填充首答与终答，追问列表为空", () => {
    const tasks = buildSampleTasks(fakeQuestion("BX"), [
      { text: "答案甲", quality: "high", note: "立场A" },
      { text: "答案乙", quality: "low", note: "依据不足" },
    ]);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].input.firstAnswer).toBe("答案甲");
    expect(tasks[0].input.finalAnswer).toBe("答案甲");
    expect(tasks[0].input.followupQuestions).toEqual([]);
    expect(tasks[0].input.mainQuestion).toBe("BX 主问题");
    expect(tasks[0].input.rubricDimensions).toEqual(DIMENSIONS);
    expect(tasks[1].sampleIndex).toBe(2);
    expect(tasks[1].note).toBe("依据不足");
  });

  it("主测维度取 ability_tags 首标签（与生产链路同一约定，R3）", () => {
    const tasks = buildSampleTasks(fakeQuestion("BX"), [{ text: "答案", quality: "high" }]);
    expect(tasks[0].input.mainDimension).toBe("问题定义");
  });

  it("note 缺失时按空串处理", () => {
    const tasks = buildSampleTasks(fakeQuestion("BX"), [{ text: "答案", quality: "high" }]);
    expect(tasks[0].note).toBe("");
  });
});

describe("overallScore", () => {
  it("取各维度 rawScore 均值", () => {
    const output: RubricScoringOutput = {
      dimensions: [
        { dimension: "问题定义", rawScore: 80, diagnosis: "d" },
        { dimension: "用户理解", rawScore: 60, diagnosis: "d" },
      ],
      topIssue: "t",
      nextFocus: "n",
    };
    expect(overallScore(output)).toBe(70);
  });
});

describe("analyzeScores", () => {
  it("计算每题 high 与 low 锚点的分离度", () => {
    const { analysis } = fixture({
      scores: [
        makeScore(makeTask("B1", 1, "high", "立场A高质量"), 85),
        makeScore(makeTask("B1", 2, "low", "流畅但依据不足"), 40),
      ],
    });
    const q = analysis.questions[0];
    expect(q.highMean).toBe(85);
    expect(q.anchorQuality).toBe("low");
    expect(q.anchorMean).toBe(40);
    expect(q.separationGap).toBe(45);
    expect(analysis.comparableCount).toBe(1);
  });

  it("无 low 样本时退用 medium 作为锚点", () => {
    const { analysis } = fixture({
      scores: [
        makeScore(makeTask("B1", 1, "high"), 80),
        makeScore(makeTask("B1", 2, "medium"), 60),
      ],
    });
    expect(analysis.questions[0].anchorQuality).toBe("medium");
    expect(analysis.questions[0].separationGap).toBe(20);
  });

  it("立场分差超过阈值记立场中立性异常", () => {
    const { analysis } = fixture({
      scores: [
        makeScore(makeTask("B1", 1, "high", "立场A高质量"), 90),
        makeScore(makeTask("B1", 2, "high", "立场 B 高质量"), 90 - STANCE_GAP_THRESHOLD - 1),
        makeScore(makeTask("B1", 3, "low"), 30),
      ],
    });
    const q = analysis.questions[0];
    expect(q.stanceFlag).toBe(true);
    expect(analysis.stanceFindings).toHaveLength(1);
    expect(analysis.stanceFindings[0]).toContain("B1");
  });

  it("立场分差在阈值内不记异常", () => {
    const { analysis } = fixture({
      scores: [
        makeScore(makeTask("B1", 1, "high", "立场A高质量"), 85),
        makeScore(makeTask("B1", 2, "high", "立场B高质量"), 80),
        makeScore(makeTask("B1", 3, "low"), 30),
      ],
    });
    expect(analysis.questions[0].stanceFlag).toBe(false);
    expect(analysis.stanceFindings).toHaveLength(0);
  });

  it("承认未知样本低于同题其他 high 超过阈值记被压低", () => {
    const { analysis } = fixture({
      scores: [
        makeScore(makeTask("B1", 1, "high", "立场A高质量"), 85),
        makeScore(makeTask("B1", 2, "high", "合理承认未知：说明证据缺口"), 85 - UNKNOWN_GAP_THRESHOLD - 1),
        makeScore(makeTask("B1", 3, "low"), 30),
      ],
    });
    const q = analysis.questions[0];
    expect(q.unknownFlag).toBe(true);
    expect(analysis.unknownFindings).toHaveLength(1);
  });

  it("承认未知样本与其他 high 相当则不记异常", () => {
    const { analysis } = fixture({
      scores: [
        makeScore(makeTask("B1", 1, "high", "立场A高质量"), 85),
        makeScore(makeTask("B1", 2, "high", "合理承认未知"), 82),
        makeScore(makeTask("B1", 3, "low"), 30),
      ],
    });
    expect(analysis.questions[0].unknownFlag).toBe(false);
  });

  it("汇总跨题 high 分布与全局锚点均分", () => {
    const { analysis } = fixture({
      scores: [
        makeScore(makeTask("B1", 1, "high"), 90),
        makeScore(makeTask("B1", 2, "low"), 40),
        makeScore(makeTask("B2", 1, "high"), 70),
        makeScore(makeTask("B2", 2, "low"), 30),
      ],
    });
    expect(analysis.highDistribution).toEqual({ count: 2, min: 70, max: 90, mean: 80 });
    expect(analysis.anchorOverallMean).toBe(35);
    expect(analysis.comparableCount).toBe(2);
  });
});

describe("buildVerdict", () => {
  it("分离健康且无异常 → 一致", () => {
    const { verdict } = fixture({
      scores: [
        makeScore(makeTask("B1", 1, "high", "立场A"), 85),
        makeScore(makeTask("B1", 2, "low"), 40),
      ],
    });
    expect(verdict.tier).toBe("consistent");
    expect(verdict.label).toContain("一致");
  });

  it("分离偏弱（未失效）→ 局部不一致", () => {
    const gap = SEPARATION_HEALTHY_GAP - 1;
    const { verdict } = fixture({
      scores: [makeScore(makeTask("B1", 1, "high"), 40 + gap), makeScore(makeTask("B1", 2, "low"), 40)],
    });
    expect(gap).toBeGreaterThanOrEqual(SEPARATION_FAIL_GAP);
    expect(verdict.tier).toBe("partial");
  });

  it("存在立场或承认未知异常 → 局部不一致", () => {
    const { verdict } = fixture({
      scores: [
        makeScore(makeTask("B1", 1, "high", "立场A高质量"), 90),
        makeScore(makeTask("B1", 2, "high", "立场B高质量"), 70),
        makeScore(makeTask("B1", 3, "low"), 30),
      ],
    });
    expect(verdict.tier).toBe("partial");
    expect(verdict.reasons.join("")).toContain("立场");
  });

  it("≥ 半数题分离失效 → 系统性偏差", () => {
    const { verdict } = fixture({
      scores: [
        makeScore(makeTask("B1", 1, "high"), 45),
        makeScore(makeTask("B1", 2, "low"), 42),
        makeScore(makeTask("B2", 1, "high"), 44),
        makeScore(makeTask("B2", 2, "low"), 43),
      ],
    });
    expect(verdict.tier).toBe("systematic");
    expect(verdict.label).toContain("系统性偏差");
  });

  it("全局锚点均分 ≥ high 均分（倒挂）→ 系统性偏差", () => {
    const { verdict } = fixture({
      scores: [makeScore(makeTask("B1", 1, "high"), 40), makeScore(makeTask("B1", 2, "low"), 60)],
    });
    expect(verdict.tier).toBe("systematic");
  });

  it("无可比较题 → 数据不足", () => {
    const failure: SampleFailure = { task: makeTask("B1", 1, "high"), error: "超时", attempts: 3 };
    const { verdict } = fixture({ failures: [failure] });
    expect(verdict.tier).toBe("insufficient-data");
  });
});

describe("createMockEvalScorer", () => {
  it("确定性：同一输入两次评分结果相同，且 high 基线高于 low", async () => {
    const highTask = makeTask("B1", 1, "high");
    const lowTask = makeTask("B1", 2, "low");
    const scorer = createMockEvalScorer([highTask, lowTask]);
    const high1 = await scorer(highTask.input);
    const high2 = await scorer(highTask.input);
    const low = await scorer(lowTask.input);
    expect(high1).toEqual(high2);
    expect(overallScore(high1)).toBeGreaterThan(overallScore(low));
    expect(high1.dimensions.map((d) => d.dimension)).toEqual(Object.keys(DIMENSIONS));
  });
});

describe("报告格式化", () => {
  it("console 摘要含逐样本行与结论", () => {
    const data = fixture({
      scores: [makeScore(makeTask("B1", 1, "high"), 85), makeScore(makeTask("B1", 2, "low"), 40)],
    });
    const text = formatConsoleSummary({ mode: "mock", model: "m", generatedAt: new Date(), ...data });
    expect(text).toContain("[B1#1]");
    expect(text).toContain("结论：");
  });

  it("markdown 报告含结论、汇总分析、逐样本明细与构造方式说明", () => {
    const data = fixture({
      scores: [makeScore(makeTask("B1", 1, "high", "立场A高质量"), 85), makeScore(makeTask("B1", 2, "low"), 40)],
    });
    const md = formatMarkdownReport({ mode: "live", model: "deepseek-flash", generatedAt: new Date("2026-10-13"), ...data });
    expect(md).toContain("## 结论：");
    expect(md).toContain("### 1. 每题分离度");
    expect(md).toContain("### 3. 立场中立性");
    expect(md).toContain("## 逐样本明细");
    expect(md).toContain("样本文本同时作为「首答」与「终答」");
    expect(md).toContain("deepseek-flash");
  });

  it("带人审对齐数据时：console 含逐题对齐行与全局块，markdown 小节插在逐样本明细之前", () => {
    const scores = [
      makeScoreWithDims(makeTask("B1", 1, "high"), { 问题定义: 85 }),
      makeScoreWithDims(makeTask("B1", 2, "low"), { 问题定义: 40 }),
    ];
    const humanAlignment = analyzeHumanAlignment(scores, {
      questions: {
        B1: {
          mainDimension: "问题定义",
          samples: [
            { sampleIndex: 1, blindId: "S1", humanScore: 88 },
            { sampleIndex: 2, blindId: "S2", humanScore: 30 },
          ],
        },
      },
    });
    const data = fixture({ scores });
    const consoleText = formatConsoleSummary({ mode: "mock", model: "m", generatedAt: new Date(), ...data, humanAlignment });
    expect(consoleText).toContain("→ B1 人审对齐：");
    expect(consoleText).toContain("人审对齐（机器主测维度 × 人审总分）：可比样本 2/2");
    expect(consoleText).toContain("分档一致 1/2");
    expect(consoleText).toContain("分差 ±3 内占比 1/2"); // S1 |差|3 在噪声带内、S2 |差|10 在带外
    expect(consoleText).toContain("同序 1 组、并列 0 组、反转 0 组");

    const md = formatMarkdownReport({ mode: "mock", model: "m", generatedAt: new Date(), ...data, humanAlignment });
    expect(md).toContain("## 人审对齐（机器主测维度 × 人审总分）");
    expect(md).toContain("| 样本 | 盲评编号 | 预设质量 | 人审 | 机器主测 | 差 | 人审档 | 机器档 |");
    expect(md).toContain("**排序一致性**：同序 1 组、并列 0 组、反转 0 组");
    expect(md).toContain("- 无排序反转");
    expect(md).not.toContain("带宽一致"); // R3：术语改「分档一致」
    expect(md).not.toContain("全部一致"); // R3：排序一节避免误读为「全部区分准确」
    expect(md.indexOf("## 人审对齐")).toBeLessThan(md.indexOf("## 逐样本明细"));
  });
});

// ===== 人审对齐分析（T33 校准 R2）=====

/** 构造指定维度分数的评分结果（人审对齐用例需要逐维度控分） */
function makeScoreWithDims(task: EvalSampleTask, dims: Record<string, number>): SampleScore {
  const values = Object.values(dims);
  return {
    task,
    output: {
      dimensions: Object.entries(dims).map(([dimension, rawScore]) => ({
        dimension,
        rawScore,
        diagnosis: `诊断 ${dimension}`,
      })),
      topIssue: "最需优化的问题",
      nextFocus: "下一步方向",
    },
    overall: values.reduce((a, b) => a + b, 0) / values.length,
    attempts: 1,
  };
}

function humanData(questions: HumanReviewData["questions"]): HumanReviewData {
  return { questions };
}

describe("scoreBand：六档刻度档界", () => {
  it("档界两侧各归各档（89/90、79/80、69/70、59/60、39/40）", () => {
    expect(scoreBand(90)).toBe("优秀");
    expect(scoreBand(89)).toBe("高质量");
    expect(scoreBand(80)).toBe("高质量");
    expect(scoreBand(79)).toBe("较好但有明显缺项");
    expect(scoreBand(70)).toBe("较好但有明显缺项");
    expect(scoreBand(69)).toBe("部分达标");
    expect(scoreBand(60)).toBe("部分达标");
    expect(scoreBand(59)).toBe("较弱");
    expect(scoreBand(40)).toBe("较弱");
    expect(scoreBand(39)).toBe("低质量");
    expect(scoreBand(100)).toBe("优秀");
    expect(scoreBand(0)).toBe("低质量");
  });
});

describe("analyzeHumanAlignment：机器主测维度分 × 人审总分", () => {
  it("计算 diff、平均绝对差、最大绝对差、分档一致、±3 占比与高低分段指标", () => {
    const scores = [
      makeScoreWithDims(makeTask("B1", 1, "high"), { 问题定义: 85 }),
      makeScoreWithDims(makeTask("B1", 2, "high"), { 问题定义: 72 }),
      makeScoreWithDims(makeTask("B1", 3, "low"), { 问题定义: 45 }),
    ];
    const result = analyzeHumanAlignment(
      scores,
      humanData({
        B1: {
          mainDimension: "问题定义",
          samples: [
            { sampleIndex: 1, blindId: "S1", humanScore: 90 },
            { sampleIndex: 2, blindId: "S2", humanScore: 70 },
            { sampleIndex: 3, blindId: "S3", humanScore: 30 },
          ],
        },
      }),
    );
    expect(result.rows.map((r) => r.label)).toEqual(["B1#1", "B1#2", "B1#3"]);
    expect(result.rows[0]).toMatchObject({
      blindId: "S1",
      machineMain: 85,
      diff: -5,
      humanBand: "优秀",
      machineBand: "高质量",
    });
    expect(result.rows[1]).toMatchObject({ diff: 2, humanBand: "较好但有明显缺项", machineBand: "较好但有明显缺项" });
    expect(result.comparedCount).toBe(3);
    expect(result.meanAbsDiff).toBeCloseTo((5 + 2 + 15) / 3, 10);
    expect(result.maxAbsDiff).toEqual({ label: "B1#3", value: 15 });
    expect(result.bandMatchCount).toBe(1); // 仅 B1#2 人机同档
    expect(result.withinNoiseCount).toBe(1); // 仅 B1#2 |diff|=2 在 ±3 噪声带内（R3 新增指标）
    expect(result.highHumanMeanMachine).toBeCloseTo((85 + 72) / 2, 10);
    expect(result.anchorMaxMachine).toBe(45);
    expect(result.rankingMismatches).toEqual([]); // 三对样本机器顺序均与人审一致
    expect(result.pairStats).toEqual({ same: 3, tied: 0, reversed: 0 });
  });

  it("人审分差在 ±3 噪声带内的排序互换不计反转", () => {
    const scores = [
      makeScoreWithDims(makeTask("B1", 1, "high"), { 问题定义: 70 }),
      makeScoreWithDims(makeTask("B1", 2, "high"), { 问题定义: 75 }),
    ];
    const result = analyzeHumanAlignment(
      scores,
      humanData({
        B1: {
          mainDimension: "问题定义",
          samples: [
            { sampleIndex: 1, blindId: "S1", humanScore: 80 },
            { sampleIndex: 2, blindId: "S2", humanScore: 80 - HUMAN_NOISE_BAND }, // 恰好压线：噪声带内
          ],
        },
      }),
    );
    expect(result.rankingMismatches).toEqual([]); // 机器 70 < 75 但人审差仅 3，不计
    expect(result.pairStats).toEqual({ same: 0, tied: 0, reversed: 0 }); // 噪声带内的样本对不参与三组计数
  });

  it("机器并列不视为反转", () => {
    const scores = [
      makeScoreWithDims(makeTask("B1", 1, "high"), { 问题定义: 70 }),
      makeScoreWithDims(makeTask("B1", 2, "high"), { 问题定义: 70 }),
    ];
    const result = analyzeHumanAlignment(
      scores,
      humanData({
        B1: {
          mainDimension: "问题定义",
          samples: [
            { sampleIndex: 1, blindId: "S1", humanScore: 90 },
            { sampleIndex: 2, blindId: "S2", humanScore: 80 },
          ],
        },
      }),
    );
    expect(result.rankingMismatches).toEqual([]);
    expect(result.pairStats).toEqual({ same: 0, tied: 1, reversed: 0 }); // 机器并列单独计数
  });

  it("超出噪声带的排序反转被记录（含人审与机器两侧分数）", () => {
    const scores = [
      makeScoreWithDims(makeTask("B1", 1, "high"), { 问题定义: 60 }),
      makeScoreWithDims(makeTask("B1", 2, "high"), { 问题定义: 70 }),
    ];
    const result = analyzeHumanAlignment(
      scores,
      humanData({
        B1: {
          mainDimension: "问题定义",
          samples: [
            { sampleIndex: 1, blindId: "S1", humanScore: 80 },
            { sampleIndex: 2, blindId: "S2", humanScore: 80 - HUMAN_NOISE_BAND - 2 },
          ],
        },
      }),
    );
    expect(result.rankingMismatches).toHaveLength(1);
    expect(result.rankingMismatches[0]).toContain("B1：人审 S1(80) > S2(75) 但机器 60 < 70");
    expect(result.pairStats).toEqual({ same: 0, tied: 0, reversed: 1 });
  });

  it("主测维度缺失的行 machineMain 为 null，不参与均值与带宽统计", () => {
    const scores = [
      makeScoreWithDims(makeTask("B1", 1, "high"), { 问题定义: 80, 用户理解: 80 }),
      makeScoreWithDims(makeTask("B1", 2, "high"), { 用户理解: 55 }), // 输出缺主测维度
    ];
    const result = analyzeHumanAlignment(
      scores,
      humanData({
        B1: {
          mainDimension: "问题定义",
          samples: [
            { sampleIndex: 1, blindId: "S1", humanScore: 80 },
            { sampleIndex: 2, blindId: "S2", humanScore: 60 },
          ],
        },
      }),
    );
    expect(result.rows[1]).toMatchObject({ machineMain: null, diff: null, machineBand: null });
    expect(result.comparedCount).toBe(1);
    expect(result.meanAbsDiff).toBe(0);
    expect(result.bandMatchCount).toBe(1);
    expect(result.withinNoiseCount).toBe(1); // B1#1 diff=0 在噪声带内
    expect(result.highHumanMeanMachine).toBe(80);
    expect(result.anchorMaxMachine).toBeNull(); // 没有人审 <40 的可比样本
    expect(result.pairStats).toEqual({ same: 0, tied: 0, reversed: 0 }); // 机器分缺失的样本对不计入
  });
});
