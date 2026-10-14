import type { RubricScoringInput, RubricScoringOutput } from "./rubric-scorer.ts";

/**
 * 评分校准回归（R1：LLM 评分一致性对策）。
 *
 * 对内置固定样例（样例答案 + 期望分数带）跑评分，输出分数漂移报告：
 * - 每个样例的每个维度给出实际分、期望分数带、是否带内、漂移量（带外距离）；
 * - 任一维度漂出分数带即回归失败（脚本退出码非 0）；
 * - mock 模式用确定性桩评分（取分数带中值），离线验证报告管线本身；
 * - 真实模式经 MiMo 网关跑同一组样例，用于上线前/换模型后的评分回归。
 *
 * 校准集维护约定（D14）：从首批题库沉淀，20~30 例为目标；MVP 先内置 3 例骨架。
 */

export interface CalibrationSample {
  id: string;
  input: RubricScoringInput;
  /** 各维度期望分数带（闭区间），与 rubricDimensions 一一对应 */
  expectedBands: Record<string, [number, number]>;
}

export type CalibrationScorer = (
  input: RubricScoringInput,
  sample: CalibrationSample,
) => Promise<RubricScoringOutput>;

export interface DimensionDrift {
  dimension: string;
  score: number;
  band: [number, number];
  inBand: boolean;
  /** 漂移量：带内为 0；带外为超出最近边界的距离 */
  drift: number;
}

export interface SampleDriftReport {
  sampleId: string;
  dimensions: DimensionDrift[];
  inBand: boolean;
}

export interface CalibrationReport {
  mode: string;
  samples: SampleDriftReport[];
  totalDimensions: number;
  outOfBandDimensions: number;
  passed: boolean;
}

export async function runCalibration(
  samples: CalibrationSample[],
  scorer: CalibrationScorer,
  options: { mode?: string } = {},
): Promise<CalibrationReport> {
  const reports: SampleDriftReport[] = [];
  for (const sample of samples) {
    const output = await scorer(sample.input, sample);
    const dimensions = Object.entries(sample.expectedBands).map(([dimension, band]) => {
      const hit = output.dimensions.find((d) => d.dimension === dimension);
      const score = hit?.rawScore ?? Number.NaN;
      const [low, high] = band;
      const inBand = Number.isFinite(score) && score >= low && score <= high;
      const drift = inBand ? 0 : score < low ? low - score : score - high;
      return { dimension, score, band, inBand, drift };
    });
    reports.push({
      sampleId: sample.id,
      dimensions,
      inBand: dimensions.every((d) => d.inBand),
    });
  }
  const totalDimensions = reports.reduce((sum, r) => sum + r.dimensions.length, 0);
  const outOfBandDimensions = reports.reduce(
    (sum, r) => sum + r.dimensions.filter((d) => !d.inBand).length,
    0,
  );
  return {
    mode: options.mode ?? "mock",
    samples: reports,
    totalDimensions,
    outOfBandDimensions,
    passed: outOfBandDimensions === 0,
  };
}

export function formatCalibrationReport(report: CalibrationReport): string {
  const lines: string[] = [
    `评分校准回归报告（模式：${report.mode}）`,
    "========================================",
  ];
  for (const sample of report.samples) {
    lines.push(`${sample.inBand ? "✓" : "✗"} 样例 ${sample.sampleId}`);
    for (const d of sample.dimensions) {
      const band = `[${d.band[0]}, ${d.band[1]}]`;
      lines.push(
        d.inBand
          ? `    ${d.dimension}：${d.score} ∈ ${band}（带内）`
          : `    ${d.dimension}：${d.score} ∉ ${band}（带外，漂移 ${d.drift}）`,
      );
    }
  }
  const inBandCount = report.totalDimensions - report.outOfBandDimensions;
  lines.push("----------------------------------------");
  lines.push(
    `带内维度 ${inBandCount}/${report.totalDimensions}；回归${report.passed ? "通过（PASS）" : "失败（FAIL）"}`,
  );
  return lines.join("\n");
}

/** 确定性桩评分：取期望分数带中值，离线验证报告管线（不真实出网） */
export function createMockScorer(): CalibrationScorer {
  return async (input, sample) => ({
    dimensions: Object.keys(input.rubricDimensions).map((dimension) => {
      const [low, high] = sample.expectedBands[dimension] ?? [0, 100];
      return {
        dimension,
        rawScore: (low + high) / 2,
        diagnosis: `mock 诊断（${dimension}）`,
      };
    }),
    topIssue: "mock 最需优化问题",
    nextFocus: "mock 下一步方向",
  });
}

/**
 * 内置校准样例（骨架，D14：后续从首批题库沉淀扩充至 20~30 例）。
 * 期望分数带刻意放宽：回归目标是检出「评分严重漂移」，而非苛责逐分一致。
 */
export const CALIBRATION_SAMPLES: CalibrationSample[] = [
  {
    id: "CAL-01-strong-answer",
    input: {
      mainDimension: "用户理解", // 首维度即主测维度（T33 R3 必填字段）
      mainQuestion: "Cursor 的 Agent 模式相对传统补全，为什么是产品形态上的质变？",
      rubricDimensions: {
        用户理解: ["区分两类任务的差异", "识别写代码之外的时间消耗", "指出人机关系变化"],
        产品价值判断: ["给出可衡量的价值判断", "说明价值成立的前提条件"],
      },
      firstAnswer:
        "首答：Agent 能自动写代码，效率更高。传统补全只是写得快，Agent 是直接帮你做完。",
      followupQuestions: ["「效率更高」的衡量证据是什么？", "如果反方认为这只是功能叠加，你如何反驳？"],
      finalAnswer:
        "终答：写代码只占工程师约 30% 的时间，其余在理解需求、调试、验证与协作。" +
        "传统补全只加速那 30%，Agent 接管的是从理解任务到交付验证的完整闭环，" +
        "工程师从「写作者」变成「审查者」，人机关系改变。价值可用任务完成率与人工接管率衡量，" +
        "前提是任务边界清晰、可自动验证。",
      },
    expectedBands: { 用户理解: [75, 100], 产品价值判断: [70, 100] },
  },
  {
    id: "CAL-02-weak-answer",
    input: {
      mainDimension: "用户理解",
      mainQuestion: "Cursor 的 Agent 模式相对传统补全，为什么是产品形态上的质变？",
      rubricDimensions: {
        用户理解: ["区分两类任务的差异", "识别写代码之外的时间消耗", "指出人机关系变化"],
        产品价值判断: ["给出可衡量的价值判断", "说明价值成立的前提条件"],
      },
      firstAnswer: "首答：因为 Agent 更智能，用户体验更好，大家都喜欢。",
      followupQuestions: ["「更智能」具体指什么？衡量证据是什么？"],
      finalAnswer:
        "终答：Agent 就是比补全好用，能少打字，体验提升很明显，应该大力推广，肯定能提升效率。",
    },
    expectedBands: { 用户理解: [0, 45], 产品价值判断: [0, 40] },
  },
  {
    id: "CAL-03-mid-answer",
    input: {
      mainDimension: "根因分析",
      mainQuestion: "滴滴高峰期动态加价被用户骂「趁火打劫」，作为产品经理你如何回应并决策是否调整？",
      rubricDimensions: {
        根因分析: ["区分情绪表层与机制根因", "识别供需失衡的核心矛盾"],
        产品取舍: ["指出至少两项代价", "给出缓释设计", "明确决策与取舍理由"],
        产品表达: ["回应具体而非套话", "结构清晰有结论"],
      },
      firstAnswer:
        "首答：动态加价是为了平衡供需，用户骂是因为不理解机制，应该加强沟通解释。",
      followupQuestions: ["只「解释机制」能解决司机侧与乘客侧哪一头的问题？"],
      finalAnswer:
        "终答：骂声表层是价格敏感，根因是高峰期供需失衡下「打不到车」的挫败被归罪于价格。" +
        "直接取消加价会牺牲司机出车意愿、加剧打不到车；维持现状则持续伤害价格敏感用户信任。" +
        "决策：保留机制但加缓释——设置加价上限、向用户展示「加价部分全部给司机」的去向、提供排队不加价选项。" +
        "回应用户时先承认体验受损，再讲机制与缓释，不讲套话。",
    },
    expectedBands: { 根因分析: [55, 90], 产品取舍: [55, 90], 产品表达: [50, 90] },
  },
];
