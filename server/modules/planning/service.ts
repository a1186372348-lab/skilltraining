import type { PrismaClient, TrainingPlan } from "@prisma/client";

import {
  getAbilityProfileView,
  type AbilityDbClient,
  type AbilityProfileDimensionView,
} from "@/server/modules/profile/ability";
import { withUserTransaction, type UserTransaction } from "@/server/lib/user-transaction";

import { reviewSnapshotSchema } from "./schemas";

import { PLANNING_ERROR_CODES as CODES, PlanningError } from "./errors";
import {
  createPrismaPlanningRepository,
  type PlanningRepository,
} from "./repository";

/**
 * 周期训练计划服务（T29 / F5 / D30；规则引擎，不用 AI——蓝图 §4 选型决策）。
 *
 * 规则：
 * - 懒生成（D30）：每周首次访问时生成本周计划（weekStartDate = 周一 0 点 UTC）；
 *   focusDimension = 画像有效分最低维度，同分按 ABILITY_DIMENSIONS 固定顺序取前者；
 *   targetScore = min(100, 当前分 + 10)（D35）；reason 为模板文案（含维度名与当前分）；
 *   并发首访撞 @@unique(userId, weekStartDate) 兜底幂等（撞车回读既有，不双写）；
 * - 未知维度（D35）：任一维度 currentScore 为 NULL（未观测）时不生成计划，
 *   抛 PlanningError(PROFILE_INCOMPLETE) 提示先完成基线测评补测；
 * - 拒绝/撤销（D33② / BR-V2-2）：active ↔ rejected 幂等（已在目标态不重复写库）；
 * - 进度聚合：本周 sourceType=plan 且已评分会话数 + 按 scoredAt 的 UTC 日期去重的完成天数；
 * - 周回顾（蓝图 §2.4）：周日及之后首访懒生成——完成天数 + 主攻维度有效分变化
 *   （startScore 对画像最新有效分，口径与 ability.ts 有效分事实源一致）；
 *   生成后将该期计划归档 status→completed（幂等）；周日前返回未生成态（null）。
 */

type DbClient = PrismaClient;

/** service 可替换依赖（测试注入内存桩；生产缺省 Prisma 仓储与真实画像视图） */
export interface PlanningDeps {
  repository?: PlanningRepository;
  getProfileView?: (db: AbilityDbClient, userId: string) => Promise<AbilityProfileDimensionView[]>;
  /** 当前时间注入（周一边界与周日判定测试） */
  now?: Date;
}

/** 本周一 0 点（UTC）；周日属于本周（与 training_sessions.date 的 @db.Date 惯例一致按 UTC 日切） */
export function weekStartUtc(date: Date): Date {
  const day = (date.getUTCDay() + 6) % 7; // 周一=0 … 周日=6
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day));
}

/** 计划选择理由模板（规则引擎固定文案，不用 AI；含维度名与当前分，R5） */
function buildReason(dimension: string, startScore: number, targetScore: number): string {
  return `「${dimension}」是你当前最弱的维度（当前 ${startScore} 分），本周集中攻它，目标 ${targetScore} 分。`;
}

/** 取画像最低分维度（同分按 ABILITY_DIMENSIONS 固定顺序——视图本身即该顺序，首个最小值即所求） */
function lowestDimension(view: AbilityProfileDimensionView[]): AbilityProfileDimensionView {
  const unknown = view.filter((d) => d.currentScore === null);
  if (unknown.length > 0) {
    // D35：存在未知维度时暂缓生成，提示先完成基线测评
    throw new PlanningError(
      CODES.PROFILE_INCOMPLETE,
      409,
      "尚有未测评的能力维度，请先完成基线测评后再生成周计划",
    );
  }
  return view.reduce((a, b) => (b.currentScore! < a.currentScore! ? b : a));
}

/** 读取或生成本周计划（懒生成幂等） */
export async function getOrCreateCurrentPlan(
  db: DbClient,
  userId: string,
  deps: PlanningDeps = {},
): Promise<TrainingPlan> {
  if (deps.repository) return getOrCreateWithRepository(db, userId, deps, deps.repository);
  return withUserTransaction(db, userId, context => getOrCreateWithRepository(context.tx, userId, deps, createPrismaPlanningRepository(context.tx)));
}

async function getOrCreateWithRepository(
  db: AbilityDbClient, userId: string, deps: PlanningDeps, repository: PlanningRepository,
): Promise<TrainingPlan> {
  const now = deps.now ?? new Date();
  const weekStart = weekStartUtc(now);

  const existing = await repository.findPlanByWeek(userId, weekStart);
  if (existing) return existing;

  const view = await (deps.getProfileView ?? getAbilityProfileView)(db, userId);
  const lowest = lowestDimension(view);
  const startScore = lowest.currentScore!; // 未知维度已在上方拦截
  const targetScore = Math.min(100, startScore + 10);
  try {
    return await repository.createPlan({
      userId,
      weekStartDate: weekStart,
      focusDimension: lowest.dimension,
      startScore,
      targetScore,
      reason: buildReason(lowest.dimension, startScore, targetScore),
    });
  } catch (error) {
    // 并发首访：另一请求已建，回读复用（@@unique(userId, weekStartDate) 兜底，不双写）；
    // 按 P2002 错误码判定（属性检查而非 instanceof——桩与真实 Prisma 错误同形可测）
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "P2002"
    ) {
      return repository.findPlanByWeek(userId, weekStart).then((plan) => {
        if (!plan) throw error;
        return plan;
      });
    }
    throw error;
  }
}

/** 拒绝/撤销本周计划（幂等：已在目标态直接返回，不重复写库） */
export async function setCurrentPlanStatus(
  db: DbClient,
  userId: string,
  status: "rejected" | "active",
  deps: PlanningDeps = {},
): Promise<TrainingPlan> {
  if (deps.repository) return setStatusWithRepository(userId, status, deps, deps.repository);
  return withUserTransaction(db, userId, context => setStatusWithRepository(userId, status, deps, createPrismaPlanningRepository(context.tx)));
}

async function setStatusWithRepository(
  userId: string, status: "rejected" | "active", deps: PlanningDeps, repository: PlanningRepository,
): Promise<TrainingPlan> {
  const now = deps.now ?? new Date();
  const plan = await repository.findPlanByWeek(userId, weekStartUtc(now));
  if (!plan) {
    throw new PlanningError(CODES.PLAN_NOT_FOUND, 404, "本周尚无训练计划");
  }
  let current = plan;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (current.status === "completed") throw new PlanningError(CODES.PLAN_COMPLETED, 409, "本周计划已归档");
    if (current.status === status) return current;
    current = await repository.changePlanStatus(userId, current.id, current.status, status);
  }
  if (current.status === "completed") throw new PlanningError(CODES.PLAN_COMPLETED, 409, "本周计划已归档");
  if (current.status === status) return current;
  throw new PlanningError(CODES.PLAN_CONFLICT, 409, "计划状态已变化，请重试");
}

export interface PlanProgressResult {
  /** 本周 sourceType=plan 且已评分会话数 */
  scoredCount: number;
  /** 按 scoredAt 的 UTC 日期去重的完成天数 */
  completedDays: number;
  completedDates: string[];
}

/** 计划进度聚合（本周 sourceType=plan 已评分会话数 + 按 scoredAt 的 UTC 日期去重完成天数） */
export async function getPlanProgress(
  db: DbClient,
  userId: string,
  plan: TrainingPlan,
  deps: PlanningDeps = {},
): Promise<PlanProgressResult> {
  if (deps.repository) return progressFromRepository(userId, plan.id, deps.repository);
  return withUserTransaction(db, userId, context => getPlanProgressInTransaction(context, plan.id));
}

/** 已持用户锁的内部路径，不嵌套公共事务。 */
async function getPlanProgressInTransaction(context: UserTransaction, planId: string): Promise<PlanProgressResult> {
  return progressFromRepository(context.userId, planId, createPrismaPlanningRepository(context.tx));
}

async function progressFromRepository(userId: string, planId: string, repository: PlanningRepository): Promise<PlanProgressResult> {
  const plan = await repository.findPlanById(userId, planId);
  if (!plan) throw new PlanningError(CODES.PLAN_NOT_FOUND, 404, "训练计划不存在");
  if (plan.reviewSnapshot != null) {
    const snapshot = reviewSnapshotSchema.parse(plan.reviewSnapshot);
    return { scoredCount: snapshot.scoredCount, completedDays: snapshot.completedDays, completedDates: [...snapshot.completedDates] };
  }
  const rows = await repository.listPlanScoredSessions(userId, plan.weekStartDate, plan.id);
  const completedDates = [...new Set(rows.map((row) => row.scoredAt.toISOString().slice(0, 10)))].sort();
  return {
    scoredCount: rows.length,
    completedDays: completedDates.length,
    completedDates,
  };
}

/** 周回顾视图（service 层契约；schemas.ts 的 weeklyReviewSchema 为 API 侧同形契约） */
export interface WeeklyReviewResult {
  plan: TrainingPlan;
  scoredCount: number;
  completedDays: number;
  startScore: number;
  /** 快照截止时该维度有效分累计均值；未知为 null */
  latestScore: number | null;
  /** 有效分变化 = latestScore − startScore（未知为 null） */
  scoreChange: number | null;
}

/** 该期计划的周回顾可生成日（周日 = weekStart + 6 天） */
function reviewableAt(plan: TrainingPlan): Date {
  const at = new Date(plan.weekStartDate);
  at.setUTCDate(at.getUTCDate() + 6);
  return at;
}

/** 周日或之后首次生成并固定回顾；本周未到周日时回看最近已结束的计划。 */
export async function getOrGenerateWeeklyReview(
  db: DbClient,
  userId: string,
  deps: PlanningDeps = {},
): Promise<WeeklyReviewResult | null> {
  if (deps.repository) return getReviewWithRepository(userId, deps, deps.repository);
  return withUserTransaction(db, userId, context => getReviewWithRepository(userId, deps, createPrismaPlanningRepository(context.tx)));
}

async function getReviewWithRepository(
  userId: string, deps: PlanningDeps, repository: PlanningRepository,
): Promise<WeeklyReviewResult | null> {
  const now = deps.now ?? new Date();
  const latestWeek = weekStartUtc(now);
  if (now.getUTCDay() !== 0) latestWeek.setUTCDate(latestWeek.getUTCDate() - 7);
  const plan = await repository.findReviewablePlan(userId, latestWeek);
  if (!plan || now < reviewableAt(plan)) return null;

  if (plan.reviewSnapshot != null) {
    const snapshot = reviewSnapshotSchema.parse(plan.reviewSnapshot);
    return { plan, ...snapshot };
  }
  const weekEnd = new Date(plan.weekStartDate.getTime() + 7 * 86400000);
  const cutoff = now < weekEnd ? now : weekEnd;
  const rows = await repository.listPlanScoredSessions(userId, plan.weekStartDate, plan.id, cutoff);
  const completedDates = [...new Set(rows.map((row) => row.scoredAt.toISOString().slice(0, 10)))].sort();
  const latestScore = await repository.averageScoreUntil(userId, plan.focusDimension, cutoff);
  const snapshot = reviewSnapshotSchema.parse({
    schemaVersion: 1, generatedAt: now.toISOString(), scoredCount: rows.length,
    completedDays: completedDates.length, completedDates, startScore: plan.startScore,
    latestScore, scoreChange: latestScore === null ? null : latestScore - plan.startScore,
  });
  const saved = await repository.saveReviewSnapshot(userId, plan, snapshot);
  return { plan: saved, ...reviewSnapshotSchema.parse(saved.reviewSnapshot) };
}
