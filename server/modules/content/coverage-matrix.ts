import type { QuestionFileResult } from "./load-questions.ts";
import {
  ABILITY_DIMENSIONS,
  DIFFICULTY_LABELS,
  type AbilityDimension,
  type DifficultyLabel,
  type QuestionContent,
} from "./question-schema.ts";

// 题库覆盖矩阵（T33 / BR-V2-8）：从校验结果集统计维度 × 难度 × 领域分布，
// 并给出每维度日常题达标缺口清单。纯函数，供 validate/import 两个脚本共用同一份报告；
// 只报告不拦截——覆盖达标核对属评审动作，不构成导入门禁

// 每维度日常题达标线（D35：组包 5 道 + 复测预留 1 道；标签命中口径，
// 与 server/modules/selection/engine.ts 按 ability_tags 过滤同维度题的口径一致）
export const DAILY_DIMENSION_TARGET = 6;

// 单维度日常题达标缺口
export interface DimensionGap {
  dimension: AbilityDimension;
  dailyCount: number; // 日常题中命中该维度（出现在 ability_tags 即计入）的题数
  gap: number; // 距达标线的缺口（0 即达标，不为负）
}

export interface CoverageMatrix {
  total: number; // 校验通过的题目总数
  daily: number; // 日常题数（kind 缺省按 daily）
  baseline: number; // 基线题数
  // 维度分布 · 标签命中口径：一题的每个 ability_tags 标签各计 1（一题可计入多个维度）
  byDimensionTagHit: Record<AbilityDimension, number>;
  // 维度分布 · 主测口径：只计 ability_tags 首标签（每题恰好计入 1 个维度）
  byDimensionPrimary: Record<AbilityDimension, number>;
  byDifficulty: Record<DifficultyLabel, number>;
  byDomain: Record<string, number>;
  // 每维度日常题达标缺口清单（固定 8 维，标签命中口径，仅统计日常题）
  dimensionGaps: DimensionGap[];
}

function zeroDimensionRecord(): Record<AbilityDimension, number> {
  return Object.fromEntries(ABILITY_DIMENSIONS.map((d) => [d, 0])) as Record<
    AbilityDimension,
    number
  >;
}

// 从校验结果集构建覆盖矩阵；校验失败（content 为 null）的结果不计入
export function buildCoverageMatrix(results: QuestionFileResult[]): CoverageMatrix {
  const contents = results
    .map((r) => r.content)
    .filter((c): c is QuestionContent => c !== null);

  const byDimensionTagHit = zeroDimensionRecord();
  const byDimensionPrimary = zeroDimensionRecord();
  const dailyTagHit = zeroDimensionRecord();
  const byDifficulty = Object.fromEntries(DIFFICULTY_LABELS.map((d) => [d, 0])) as Record<
    DifficultyLabel,
    number
  >;
  const byDomain: Record<string, number> = {};
  let daily = 0;
  let baseline = 0;

  for (const content of contents) {
    const isDaily = (content.kind ?? "daily") !== "baseline";
    if (isDaily) {
      daily += 1;
    } else {
      baseline += 1;
    }
    byDifficulty[content.difficulty] += 1;
    byDomain[content.domain] = (byDomain[content.domain] ?? 0) + 1;
    content.ability_tags.forEach((tag, index) => {
      byDimensionTagHit[tag] += 1;
      if (index === 0) {
        byDimensionPrimary[tag] += 1;
      }
      if (isDaily) {
        dailyTagHit[tag] += 1;
      }
    });
  }

  const dimensionGaps = ABILITY_DIMENSIONS.map((dimension) => ({
    dimension,
    dailyCount: dailyTagHit[dimension],
    gap: Math.max(0, DAILY_DIMENSION_TARGET - dailyTagHit[dimension]),
  }));

  return {
    total: contents.length,
    daily,
    baseline,
    byDimensionTagHit,
    byDimensionPrimary,
    byDifficulty,
    byDomain,
    dimensionGaps,
  };
}

// CLI 报告：固定顺序输出（维度按 ABILITY_DIMENSIONS 声明序、难度按标签序、
// 领域按题数降序再按名称排序），保证重复执行输出稳定可 diff
export function formatCoverageReport(matrix: CoverageMatrix): string {
  const lines: string[] = [];
  lines.push(
    `覆盖矩阵（校验通过 ${matrix.total} 题：日常 ${matrix.daily} / 基线 ${matrix.baseline}）`,
  );

  lines.push("维度分布（标签命中｜主测首标签）：");
  for (const dimension of ABILITY_DIMENSIONS) {
    lines.push(
      `  ${dimension.padEnd(6, "　")} 命中 ${matrix.byDimensionTagHit[dimension]}｜主测 ${matrix.byDimensionPrimary[dimension]}`,
    );
  }

  lines.push(
    `难度分布：${DIFFICULTY_LABELS.map((d) => `${d} ${matrix.byDifficulty[d]}`).join("｜")}`,
  );

  lines.push("领域分布：");
  const domains = Object.entries(matrix.byDomain).sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  );
  if (domains.length === 0) {
    lines.push("  （无）");
  } else {
    for (const [domain, count] of domains) {
      lines.push(`  ${domain} ${count}`);
    }
  }

  lines.push(`日常题达标缺口（每维度 ≥${DAILY_DIMENSION_TARGET}，标签命中口径）：`);
  for (const { dimension, dailyCount, gap } of matrix.dimensionGaps) {
    const mark = gap === 0 ? "[达标]" : "[缺口]";
    const suffix = gap === 0 ? "" : `，缺 ${gap}`;
    lines.push(`  ${mark} ${dimension} 现有 ${dailyCount}${suffix}`);
  }

  return lines.join("\n");
}
