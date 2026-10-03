/**
 * 自适应出题引擎 v0.1（Prd.md 图 2 / BR-5 / D11 / US-010 / FR-2）：纯函数，不触库。
 *
 * 引擎刻意保持零项目内依赖（不 import 画像模块），使 scripts/selection-demo.ts
 * 可以用 node 直接运行本文件（node 的类型剥离不支持「@/」别名与无扩展名导入）。
 *
 * 流程（与图 2 一一对应）：
 * 1. 阶段判定：存在未知维度 → 探索期（优先覆盖未知维度）；否则 → 强化期（最低分维度为弱项，
 *    弱项提示依赖高时优先「独立性训练」标注题）；
 * 2. 过滤：已练题目、近期同类案例（同产品，回看最近 RECENT_CASE_WINDOW 次）；
 * 3. 匹配：兴趣领域（关键词软匹配）、难度梯度（探索期基础优先；强化期按弱项分数取目标难度）；
 * 4. 首次训练优先用户熟悉产品相关案例（D11）；
 * 5. 输出选题结果与可解释理由（供「为什么是它」展示）。
 *
 * 降级策略：任一过滤把候选池筛空时逐级放宽并记录 relaxedFilters，保证有题可选；
 * 候选池本身为空时返回 null，由服务层走「顺序取未练题」兜底。
 *
 * 关键词约定（题库 schema 尚无结构化字段前的 v0.1 过渡方案）：
 * - 「独立性训练」标注：案例文本（case_title / case_background / main_question）中含
 *   INDEPENDENCE_TRAINING_MARKER 字样即视为标注题，供内容侧按需加注；
 * - 兴趣领域：按「/」与空白切分后做子串匹配（如「电商/交易」命中含「电商」的案例文本）；
 * - 熟悉产品：产品名作为子串在案例文本中命中（D11）。
 */

/** 近期同类案例窗口：只回看最近 N 次训练的案例产品 */
export const RECENT_CASE_WINDOW = 3;

/** 「独立性训练」标注关键词（内容侧约定，见模块头注释） */
export const INDEPENDENCE_TRAINING_MARKER = "独立性训练";

export type HintDependencyBand = "低" | "中" | "高";

/**
 * 引擎需要的画像维度最小视图。
 * 与画像模块的 AbilityProfileDimensionView 结构兼容（服务层直接传入，tsc 校验）；
 * 只取选题所需字段，避免引擎依赖画像模块文件。
 */
export interface ProfileDimensionView {
  dimension: string;
  observed: boolean;
  currentScore: number | null;
  hintDependency: number | null;
  hintDependencyBand: HintDependencyBand | null;
}

/** 提示依赖分档（与画像模块 hintDependencyBand 口径一致：<1 低 / 1~2.5 中 / >2.5 高）；视图未带分档时的兜底 */
function bandOf(value: number | null): HintDependencyBand | null {
  if (value === null) return null;
  if (value < 1) return "低";
  if (value <= 2.5) return "中";
  return "高";
}

/** 选题引擎需要的最小题目字段（Question 行天然满足该结构） */
export interface CandidateQuestion {
  id: string;
  caseTitle: string;
  caseBackground: unknown;
  mainQuestion: string;
  abilityTags: unknown;
  difficulty: number;
}

export interface SelectionInput {
  /** 全 8 维画像视图（未观测维度为未知态） */
  profile: ProfileDimensionView[];
  /** user_profiles.familiar_products（D11） */
  familiarProducts: string[];
  /** user_profiles.interest_areas */
  interestAreas: string[];
  /** 全部上架题（调用方保证 status=published，按 id 升序传入） */
  questions: CandidateQuestion[];
  /** 用户已练过的题目 id 集合 */
  practicedQuestionIds: ReadonlySet<string>;
  /** 最近 N 次训练题目的 caseBackground（近期同类案例判定用） */
  recentCaseBackgrounds: unknown[];
  /** 是否首次训练（无任何历史会话） */
  isFirstTraining: boolean;
}

export type SelectionPhase = "exploration" | "strengthening" | "fallback";

export interface SelectionOutcome {
  questionId: string;
  phase: SelectionPhase;
  /** 本题瞄准的目标维度（探索期=未知维度，强化期=最弱维度） */
  targetDimensions: string[];
  /** 可解释选题理由（供「为什么是它」展示） */
  reason: string;
  /** 被放宽的过滤项（可解释性的一部分；空数组表示未放宽） */
  relaxedFilters: string[];
  matchedInterest: string | null;
  matchedFamiliarProduct: string | null;
  independenceTraining: boolean;
}

/** 解析 ability_tags jsonb：仅保留字符串项（导入管线已校验，这里做防御性读取） */
export function parseAbilityTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

/** 从 case_background.product 提取产品名（首个分隔符之前的部分），供同类案例与熟悉产品判定 */
export function extractCaseProductKey(caseBackground: unknown): string {
  if (typeof caseBackground !== "object" || caseBackground === null) return "";
  const product = (caseBackground as { product?: unknown }).product;
  if (typeof product !== "string") return "";
  const separators = ["——", "—", "：", ":", "，", ","];
  let end = product.length;
  for (const sep of separators) {
    const index = product.indexOf(sep);
    if (index >= 0 && index < end) end = index;
  }
  return product.slice(0, end).trim();
}

/** 拼接案例全部展示文本（标题 + 背景各字段 + 主问题），供关键词匹配 */
export function buildCaseText(question: CandidateQuestion): string {
  const parts: string[] = [question.caseTitle, question.mainQuestion];
  if (typeof question.caseBackground === "object" && question.caseBackground !== null) {
    for (const value of Object.values(question.caseBackground)) {
      if (typeof value === "string") parts.push(value);
    }
  }
  return parts.join("\n");
}

/**
 * 兴趣领域软匹配：把每个兴趣词按「/」与空白切成关键词（丢弃单字），
 * 任一关键词命中案例文本即算该兴趣命中；返回第一个命中的兴趣词。
 */
export function matchesInterestAreas(text: string, interestAreas: string[]): string | null {
  for (const area of interestAreas) {
    const keywords = area
      .split(/[/\s]+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 2);
    if (keywords.some((word) => text.includes(word))) return area;
  }
  return null;
}

/** 熟悉产品匹配：产品名作为子串命中案例文本；返回第一个命中的产品名 */
function matchesFamiliarProduct(text: string, familiarProducts: string[]): string | null {
  for (const product of familiarProducts) {
    if (product.length > 0 && text.includes(product)) return product;
  }
  return null;
}

/** 难度展示标签（与题库难度映射一致：2 基础 / 3 中等 / 4 挑战） */
function difficultyLabel(difficulty: number): string {
  if (difficulty <= 2) return "基础";
  if (difficulty === 3) return "中等";
  return "挑战";
}

/** 目标难度：探索期基础优先（便于建立首次观测）；强化期按弱项分数取梯度 */
function targetDifficulty(phase: SelectionPhase, weakestScore: number | null): number {
  if (phase !== "strengthening" || weakestScore === null) return 2;
  if (weakestScore < 60) return 2;
  if (weakestScore < 80) return 3;
  return 4;
}

interface Decorated {
  question: CandidateQuestion;
  tags: string[];
  text: string;
  familiar: string | null;
  independence: boolean;
  interest: string | null;
  coverageCount: number;
  difficultyDistance: number;
}

/** 按图 2 逻辑选题；候选池为空返回 null（交由服务层降级） */
export function selectQuestion(input: SelectionInput): SelectionOutcome | null {
  if (input.questions.length === 0) return null;

  // ── 阶段判定（图 2 B 节点）──
  const unknownDimensions = input.profile.filter((d) => !d.observed).map((d) => d.dimension);
  const observedDimensions = input.profile.filter((d) => d.observed);
  const exploration = observedDimensions.length === 0 || unknownDimensions.length > 0;

  let phase: SelectionPhase;
  let targetDimensions: string[];
  let weakestScore: number | null = null;
  let weakestHighHintDependency = false;
  if (exploration) {
    phase = "exploration";
    targetDimensions = unknownDimensions;
  } else {
    phase = "strengthening";
    // 最低分维度为弱项；同分取画像固定顺序中的前者
    const weakest = observedDimensions.reduce((a, b) =>
      (b.currentScore ?? 0) < (a.currentScore ?? 0) ? b : a,
    );
    weakestScore = weakest.currentScore;
    targetDimensions = [weakest.dimension];
    const band = weakest.hintDependencyBand ?? bandOf(weakest.hintDependency);
    weakestHighHintDependency = band === "高";
  }

  const relaxedFilters: string[] = [];

  // ── 过滤：已练题目（图 2 G 节点）──
  let pool = input.questions.filter((q) => !input.practicedQuestionIds.has(q.id));
  if (pool.length === 0) {
    relaxedFilters.push("已练题目");
    pool = [...input.questions];
  }

  // ── 过滤：近期同类案例（同产品，图 2 G 节点）──
  const recentProductKeys = new Set(
    input.recentCaseBackgrounds.map(extractCaseProductKey).filter((key) => key.length > 0),
  );
  if (recentProductKeys.size > 0) {
    const withoutRecent = pool.filter(
      (q) => !recentProductKeys.has(extractCaseProductKey(q.caseBackground)),
    );
    if (withoutRecent.length > 0) {
      pool = withoutRecent;
    } else {
      relaxedFilters.push("近期同类案例");
    }
  }

  // ── 目标维度覆盖（探索期 C / 强化期 E 节点）──
  if (targetDimensions.length > 0) {
    const targetSet = new Set(targetDimensions);
    const covering = pool.filter((q) =>
      parseAbilityTags(q.abilityTags).some((tag) => targetSet.has(tag)),
    );
    if (covering.length > 0) {
      pool = covering;
    } else {
      relaxedFilters.push("目标维度覆盖");
    }
  }

  // ── 装饰与排序（图 2 F/H/I/J/K 节点）──
  const difficultyGoal = targetDifficulty(phase, weakestScore);
  const targetSet = new Set(targetDimensions);
  const decorated: Decorated[] = pool.map((question) => {
    const tags = parseAbilityTags(question.abilityTags);
    const text = buildCaseText(question);
    return {
      question,
      tags,
      text,
      // D11：仅首次训练生效
      familiar: input.isFirstTraining ? matchesFamiliarProduct(text, input.familiarProducts) : null,
      // BR-5：仅强化期且弱项提示依赖高时生效
      independence:
        phase === "strengthening" &&
        weakestHighHintDependency &&
        text.includes(INDEPENDENCE_TRAINING_MARKER),
      interest: matchesInterestAreas(text, input.interestAreas),
      coverageCount: tags.filter((tag) => targetSet.has(tag)).length,
      difficultyDistance: Math.abs(question.difficulty - difficultyGoal),
    };
  });

  // 排序优先级：熟悉产品（D11）→ 独立性训练 → 兴趣 → 目标维度覆盖数 → 难度梯度 → 传入顺序
  decorated.sort((a, b) => {
    const familiarDiff = (a.familiar !== null ? 1 : 0) - (b.familiar !== null ? 1 : 0);
    if (familiarDiff !== 0) return -familiarDiff;
    const independenceDiff = (a.independence ? 1 : 0) - (b.independence ? 1 : 0);
    if (independenceDiff !== 0) return -independenceDiff;
    const interestDiff = (a.interest !== null ? 1 : 0) - (b.interest !== null ? 1 : 0);
    if (interestDiff !== 0) return -interestDiff;
    if (a.coverageCount !== b.coverageCount) return b.coverageCount - a.coverageCount;
    return a.difficultyDistance - b.difficultyDistance;
  });

  const chosen = decorated[0];

  // ── 理由文本（「为什么是它」）──
  const reasonSegments: string[] = [];
  if (phase === "exploration") {
    if (targetDimensions.length === 0) {
      reasonSegments.push("能力探索期：暂无画像观测数据，按难度梯度从基础题开始建立画像");
    } else if (chosen.coverageCount > 0) {
      const covered = chosen.tags.filter((tag) => targetSet.has(tag));
      reasonSegments.push(
        `能力探索期：还有 ${targetDimensions.length} 个维度尚未观测，本题优先覆盖未知维度「${covered.join("、")}」`,
      );
    } else {
      reasonSegments.push(
        `能力探索期：题库暂无覆盖未知维度「${targetDimensions.join("、")}」的可出题，先从全池按梯度选题`,
      );
    }
  } else {
    reasonSegments.push(
      `针对强化期：「${targetDimensions[0]}」当前 ${weakestScore} 分为你的最低分维度，本题针对该维度强化`,
    );
  }
  if (chosen.independence) {
    reasonSegments.push("你近期的提示依赖偏高，优先安排「独立性训练」题，练习不依赖提示完成作答");
  }
  if (chosen.interest !== null) {
    reasonSegments.push(`结合你的兴趣领域「${chosen.interest}」`);
  }
  if (chosen.familiar !== null) {
    reasonSegments.push(`首次训练，优先选了你熟悉的产品「${chosen.familiar}」相关案例`);
  }
  reasonSegments.push(`难度「${difficultyLabel(chosen.question.difficulty)}」符合当前训练梯度`);
  for (const relaxed of relaxedFilters) {
    if (relaxed === "已练题目") {
      reasonSegments.push("未练题目已用完，放宽过滤安排重练巩固");
    } else if (relaxed === "近期同类案例") {
      reasonSegments.push("近期同类案例较多，放宽同类案例过滤");
    } else if (relaxed === "目标维度覆盖" && phase === "strengthening") {
      reasonSegments.push("题库暂无覆盖弱项维度的可出题，从全池按梯度选题");
    }
  }

  return {
    questionId: chosen.question.id,
    phase,
    targetDimensions,
    reason: reasonSegments.join("；"),
    relaxedFilters,
    matchedInterest: chosen.interest,
    matchedFamiliarProduct: chosen.familiar,
    independenceTraining: chosen.independence,
  };
}
