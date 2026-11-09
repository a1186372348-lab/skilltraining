import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

import { assertAbilityResultsVisible, BaselineRequiredError } from "@/server/modules/baseline/result-visibility";
import { getPackAvailability, type PackAvailability } from "@/server/modules/packs";
import { PackError } from "@/server/modules/packs/errors";

import type {
  AbilityDbClient,
  AbilityProfileDimensionView,
  HintDependencyBand,
  Trend,
} from "./ability";
import { getAbilityProfileView, hintDependencyBand } from "./ability";
import { ABILITY_DIMENSIONS } from "./schema";

/**
 * 能力画像页（P2）的视图装配（T09 / US-008 / FR-8 / BR-6）。
 *
 * 在 getAbilityProfileView 的全 8 维视图之上补充页面所需的派生信息：
 * - 状态标签：观察 < 3 次一律「样本较少」（样本不足不解读趋势），否则按趋势打标；
 * - 趋势火花线：近 N 次有效分序列（时间升序），从 scores 表读取；
 * - 顶部洞察：已了解 n/8 + 基于画像的下一步练习建议；
 * - 整体提示依赖度：已观测维度提示依赖的平均与分档（BR-6 诊断素材）。
 *
 * 存在未观测维度时先建议探索；全部已观测时根据最低分维度及其提示依赖给出行动。
 * 实际选题还受周计划等因素影响，建议不承诺下一题的维度。
 */

/** 状态标签的样本门槛：观察次数 < 3 不解读趋势（均值噪声大） */
export const STATUS_SAMPLE_THRESHOLD = 3;

/** 火花线取最近 N 次有效分 */
export const SPARKLINE_MAX_POINTS = 6;

export type AbilityStatusLabel = "稳定" | "样本较少" | "↑ 上升中" | "↓ 下降中";

/** 维度状态标签：样本较少优先于趋势（US-008） */
export function statusLabelOf(
  observationCount: number,
  trend: Trend | null,
): AbilityStatusLabel {
  if (observationCount < STATUS_SAMPLE_THRESHOLD) return "样本较少";
  if (trend === "上升") return "↑ 上升中";
  if (trend === "下降") return "↓ 下降中";
  return "稳定";
}

export interface NextFocus {
  dimension: string;
  /** explore = 探索期（存在未观测维度）；strengthen = 强化期（全部已观测） */
  mode: "explore" | "strengthen";
  text: string;
}

const FOCUS_ACTIONS: Record<string, string> = {
  问题定义: "写清目标用户及其要解决的问题",
  用户理解: "列出目标用户的关键需求并找证据验证",
  根因分析: "列出可能原因并设计方法逐一排查",
  产品价值判断: "写出用户价值和业务价值及其判断依据",
  方案设计: "围绕关键问题列出方案及主要使用步骤",
  产品取舍: "列出备选方案，说明选择标准和放弃的代价",
  指标与验证: "选定一个核心指标并写出验证办法",
  产品表达: "先写结论，再用关键依据解释判断",
};

function hintAdvice(value: number | null): { label: string; action: string } {
  switch (hintDependencyBand(value)) {
    case "高": return { label: "提示依赖较高", action: "先独立列出判断和依据，再按需看提示" };
    case "中": return { label: "提示依赖适中", action: "先写出判断，需要时再看提示" };
    case "低": return { label: "提示依赖较低", action: "保持独立作答，检查依据是否充分" };
    default: return { label: "提示依赖资料不足", action: "记录提示使用，积累后再判断依赖情况" };
  }
}

function dimensionOrder(dimension: string): number {
  const index = (ABILITY_DIMENSIONS as readonly string[]).indexOf(dimension);
  return index < 0 ? ABILITY_DIMENSIONS.length : index;
}

/** 未知维度先探索；其余按最低分及提示依赖给出建议。 */
export function nextFocusOf(dimensions: AbilityProfileDimensionView[]): NextFocus {
  const ordered = [...dimensions].sort((a, b) => dimensionOrder(a.dimension) - dimensionOrder(b.dimension));
  const unobserved = ordered.find((d) => !d.observed);
  if (unobserved) {
    return {
      dimension: unobserved.dimension,
      mode: "explore",
      text: `当前建议先探索「${unobserved.dimension}」，积累该维度的作答记录`,
    };
  }
  // 强化期：当前分最低者优先；同分取观察次数较少者；再同取维度序前者（sort 稳定）
  const weakest = [...ordered].sort(
    (a, b) =>
      (a.currentScore ?? 0) - (b.currentScore ?? 0) ||
      a.observationCount - b.observationCount,
  )[0];
  const score = weakest.currentScore === null
    ? "分数暂无"
    : `${Math.round(weakest.currentScore * 10) / 10} 分`;
  const hint = hintAdvice(weakest.hintDependency);
  const action = FOCUS_ACTIONS[weakest.dimension] ?? "写出判断及其依据";
  return {
    dimension: weakest.dimension,
    mode: "strengthen",
    text: `当前建议重点练「${weakest.dimension}」（${score}，${hint.label}）：${action}；${hint.action}`,
  };
}

export interface OverallHintDependency {
  average: number;
  band: HintDependencyBand;
}

/** 整体提示依赖度：已观测维度提示依赖数值的平均，分档复用既有规则（<1 低 / 1~2.5 中 / >2.5 高） */
export function overallHintDependencyOf(
  dimensions: AbilityProfileDimensionView[],
): OverallHintDependency | null {
  const values = dimensions
    .filter((d) => d.observed && d.hintDependency !== null)
    .map((d) => d.hintDependency as number);
  if (values.length === 0) return null;
  const average = Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 100) / 100;
  // average 非 null，分档必然有值
  return { average, band: hintDependencyBand(average) as HintDependencyBand };
}

/** 页面用的单维度视图：画像视图 + 状态标签 + 火花线序列 + 最近评估记录（T18 网络图弹窗数据源） */
export interface RecentEvaluation {
  /** 训练会话 id（弹窗「查看评估」跳转 /training/feedback/[sessionId]，T25 路径） */
  sessionId: string;
  /** 该次评分的有效分 */
  score: number;
  /** 评分完成时间 */
  scoredAt: Date;
  /** 关联题目的案例标题（一句话简介） */
  caseTitle: string;
  confidence: number | null;
}

export interface AbilityDimensionPageView extends AbilityProfileDimensionView {
  statusLabel: AbilityStatusLabel | null;
  sparkline: number[];
  /** 该维度最近评分记录列表（时间倒序，上限 SPARKLINE_MAX_POINTS 条）；未观测为空数组（T18 / D21） */
  recentEvaluations: RecentEvaluation[];
  /** 近 N 次有效分序列（时间升序，与火花线同口径），供网络图弹窗趋势（T16） */
  recentScores: number[];
  packCta: PackCta;
}

export interface PackCta {
  status: "available" | "active-self" | "disabled-other-active" | "disabled-insufficient" | "baseline-required";
  activePackId: string | null;
  completedCount: number | null;
  availableQuestions: number;
  requiredQuestions: number;
}

function packCtaOf(availability: PackAvailability): PackCta {
  const statuses = {
    available: "available",
    active_same_dimension: "active-self",
    active_other_dimension: "disabled-other-active",
    insufficient_questions: "disabled-insufficient",
    baseline_required: "baseline-required",
  } as const;
  return {
    status: statuses[availability.status], activePackId: availability.activePackId,
    completedCount: availability.completedCount, availableQuestions: availability.availableQuestions,
    requiredQuestions: availability.requiredQuestions,
  };
}

export interface AbilityPageView {
  insight: {
    observedCount: number;
    totalCount: number;
    nextFocus: NextFocus;
  };
  dimensions: AbilityDimensionPageView[];
  hintDependencyOverall: OverallHintDependency | null;
}

/** 响应负载校验（系统边界防御：装配结果不合法时快速失败，不下发脏数据） */
export const abilityPageViewSchema = z.object({
  insight: z.object({
    observedCount: z.number().int().min(0),
    totalCount: z.number().int().positive(),
    nextFocus: z.object({
      dimension: z.string().min(1),
      mode: z.enum(["explore", "strengthen"]),
      text: z.string().min(1),
    }),
  }),
  dimensions: z.array(
    z.object({
      dimension: z.string().min(1),
      observed: z.boolean(),
      currentScore: z.number().min(0).max(100).nullable(),
      observationCount: z.number().int().min(0),
      hintDependency: z.number().min(0).nullable(),
      hintDependencyBand: z.enum(["低", "中", "高"]).nullable(),
      trend: z.enum(["上升", "稳定", "下降"]).nullable(),
      updatedAt: z.date().nullable(),
      statusLabel: z.enum(["稳定", "样本较少", "↑ 上升中", "↓ 下降中"]).nullable(),
      sparkline: z.array(z.number()),
      recentEvaluations: z.array(
        z.object({
          sessionId: z.string().min(1),
          score: z.number(),
          scoredAt: z.date(),
          caseTitle: z.string().min(1),
          confidence: z.number().int().min(0).max(100).nullable(),
        }),
      ),
      recentScores: z.array(z.number()),
      packCta: z.object({
        status: z.enum(["available", "active-self", "disabled-other-active", "disabled-insufficient", "baseline-required"]),
        activePackId: z.string().min(1).nullable(),
        completedCount: z.number().int().min(0).max(5).nullable(),
        availableQuestions: z.number().int().min(0),
        requiredQuestions: z.number().int().positive(),
      }),
    }),
  ),
  hintDependencyOverall: z
    .object({ average: z.number().min(0), band: z.enum(["低", "中", "高"]) })
    .nullable(),
});

/** 指定维度近 N 次有效评分的读取结果（时间升序） */
interface RecentScoreSeries {
  /** 有效分序列（火花线与 recentScores 共用同一口径） */
  scores: number[];
  /** 该维度最近评分记录列表（时间倒序，与查询同序），供弹窗「最近评估记录」（T18） */
  recentEvaluations: RecentEvaluation[];
}

/** 读取指定维度近 N 次有效评分：火花线/趋势序列（时间升序）+ 最近评估记录列表（时间倒序，T18） */
async function recentScoreSeries(
  db: AbilityDbClient,
  userId: string,
  dimension: string,
): Promise<RecentScoreSeries> {
  const recent = await db.score.findMany({
    // 只取已完成评分的会话（scoredAt 为空者不构成评估记录）
    where: { dimension, session: { userId, scoredAt: { not: null } } },
    orderBy: { session: { scoredAt: "desc" } },
    take: SPARKLINE_MAX_POINTS,
    select: {
      effectiveScore: true,
      confidence: true,
      session: {
        select: { id: true, scoredAt: true, question: { select: { caseTitle: true } } },
      },
    },
  });
  return {
    scores: recent.map((row) => row.effectiveScore).reverse(),
    // scoredAt 已按 where 过滤非空；此处仍做空值守卫以满足类型
    recentEvaluations: recent
      .filter((row) => row.session.scoredAt !== null)
      .map((row) => ({
        sessionId: row.session.id,
        score: row.effectiveScore,
        scoredAt: row.session.scoredAt as Date,
        caseTitle: row.session.question.caseTitle,
        confidence: Number.isInteger(row.confidence) && row.confidence !== null && row.confidence >= 0 && row.confidence <= 100
          ? row.confidence
          : null,
      })),
  };
}

/** 读取并装配画像页完整视图（统一响应封装的 data 负载） */
export async function getAbilityPageView(
  db: PrismaClient,
  userId: string,
): Promise<AbilityPageView> {
  await assertAbilityResultsVisible(db, userId);
  const profileView = await getAbilityProfileView(db, userId);
  let availability: PackAvailability[];
  try {
    availability = await getPackAvailability(db, userId, profileView.map((dim) => dim.dimension));
  } catch (error) {
    // 包查询内会再次检查基线；并发期间不可把门禁错误降级为画像成功。
    if (error instanceof PackError && error.code === "BASELINE_REQUIRED") throw new BaselineRequiredError();
    throw error;
  }
  const availabilityByDimension = new Map(availability.map((item) => [item.dimension, item]));
  const dimensions: AbilityDimensionPageView[] = await Promise.all(
    profileView.map(async (dim) => {
      const availabilityForDimension = availabilityByDimension.get(dim.dimension);
      if (!availabilityForDimension) throw new Error("训练包可用性缺少维度");
      const packCta = packCtaOf(availabilityForDimension);
      if (!dim.observed) {
        return { ...dim, statusLabel: null, sparkline: [], recentEvaluations: [], recentScores: [], packCta };
      }
      const series = await recentScoreSeries(db, userId, dim.dimension);
      return {
        ...dim,
        statusLabel: statusLabelOf(dim.observationCount, dim.trend),
        sparkline: series.scores,
        recentEvaluations: series.recentEvaluations,
        recentScores: series.scores,
        packCta,
      };
    }),
  );
  const observedCount = dimensions.filter((d) => d.observed).length;
  return abilityPageViewSchema.parse({
    insight: {
      observedCount,
      totalCount: dimensions.length,
      nextFocus: nextFocusOf(dimensions),
    },
    dimensions,
    hintDependencyOverall: overallHintDependencyOf(dimensions),
  });
}
