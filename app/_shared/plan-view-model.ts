/**
 * 周期训练计划 view-model（T29 切片 5 / F5）：大厅计划条/计划详情与首页悬挂卡的
 * 展示判定全部下沉为纯函数，组件只负责渲染（与 app/_shared/nav-items 同一模式）。
 *
 * 数据源：GET /api/plans/current（plan + progress）与 /api/plans/review（review）——
 * 契约见 server/modules/planning/schemas.ts。本文件类型为前端视角镜像（可选字段防御旧响应）。
 */

/** 计划视图（前端视角，与 trainingPlanViewSchema 同形） */
export interface TrainingPlanView {
  id: string;
  /** 周一（ISO 日期 YYYY-MM-DD，UTC 口径） */
  weekStartDate: string;
  focusDimension: string;
  startScore: number;
  targetScore: number;
  status: "active" | "rejected" | "completed";
  reason: string;
  createdAt: string;
}

/** 计划进度聚合（本周 plan 题） */
export interface PlanProgressView {
  scoredCount: number;
  completedDays: number;
  completedDates?: string[];
}

/** 周回顾视图（与 weeklyReviewSchema 同形） */
export interface WeeklyReviewView {
  plan: TrainingPlanView;
  scoredCount: number;
  completedDays: number;
  startScore: number;
  latestScore: number | null;
  scoreChange: number | null;
}

/* ============================== 排期三态（周一至周五） ============================== */

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五"] as const;

/** 排期日单元：state = done（今日之前）/ today（今天）/ future（未来） */
export interface PlanDayView {
  dateLabel: string; // M/D
  weekdayLabel: string;
  state: "done" | "today" | "future" | "missed";
  isToday: boolean;
}

/**
 * 周一至周五排期三态：以 weekStartDate（ISO 日期）+ 今日 UTC 对齐。
 * 完成状态仅依据服务端提供的 UTC 完成日期；旧响应无日期时不推断完成。
 */
export function planWeekDays(weekStartDate: string, today: Date, completedDates: readonly string[] = []): PlanDayView[] {
  const [y, m, d] = weekStartDate.split("-").map(Number);
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return WEEKDAY_LABELS.map((weekdayLabel, index) => {
    const date = new Date(Date.UTC(y, m - 1, d + index));
    const isToday = date.getTime() === todayUtc.getTime();
    const state = completedDates.includes(date.toISOString().slice(0, 10)) ? "done" : date < todayUtc ? "missed" : isToday ? "today" : "future";
    return {
      dateLabel: `${date.getUTCMonth() + 1}/${date.getUTCDate()}`,
      weekdayLabel,
      state,
      isToday,
    };
  });
}

/* ============================== 进度与状态呈现 ============================== */

/** 进度文案：「本周已完成 N 天 · 已评分 M 题」 */
export function progressTextFor(progress: PlanProgressView): string {
  return `本周已完成 ${progress.completedDays} 天 · 已评分 ${progress.scoredCount} 题`;
}

/** 状态标签：active 生效中 / rejected 已拒绝 / completed 已归档 */
export function statusLabelFor(status: TrainingPlanView["status"]): {
  label: string;
  tone: "active" | "rejected" | "completed";
} {
  switch (status) {
    case "active":
      return { label: "生效中", tone: "active" };
    case "rejected":
      return { label: "已拒绝", tone: "rejected" };
    case "completed":
      return { label: "已归档", tone: "completed" };
  }
}

/** 拒绝/撤销动作（completed 不可操作返回 null） */
export function rejectActionFor(
  plan: TrainingPlanView,
): { action: "reject" | "unreject"; label: string } | null {
  if (plan.status === "active") return { action: "reject", label: "拒绝本周计划" };
  if (plan.status === "rejected") return { action: "unreject", label: "撤销拒绝" };
  return null;
}

/* ============================== 周回顾卡 ============================== */

/** 周回顾卡视图（tone：up 提升 / down 回落 / flat 持平或数据不足） */
export interface ReviewCardView {
  title: string;
  /** 完成天数与题数文案 */
  daysText: string;
  /** 主攻维度有效分变化文案（startScore → latestScore（±x）；未知兜底「暂无」） */
  scoreText: string;
  tone: "up" | "down" | "flat";
  dimension: string;
}

/** 周回顾卡映射：review 为 null（未生成态）返回 null（不渲染卡） */
export function reviewCardFor(review: WeeklyReviewView | null): ReviewCardView | null {
  if (!review) return null;
  const daysText = `本周完成 ${review.completedDays} 天 · 已评分 ${review.scoredCount} 题`;
  let scoreText: string;
  let tone: ReviewCardView["tone"];
  if (review.scoreChange === null || review.latestScore === null) {
    scoreText = `主攻维度「${review.plan.focusDimension}」：起步 ${review.startScore} 分，本周暂无最新有效分`;
    tone = "flat";
  } else {
    const sign = review.scoreChange > 0 ? "+" : "";
    scoreText = `主攻维度「${review.plan.focusDimension}」：${review.startScore} → ${review.latestScore} 分（${sign}${review.scoreChange}）`;
    tone = review.scoreChange > 0 ? "up" : review.scoreChange < 0 ? "down" : "flat";
  }
  return { title: "周回顾", daysText, scoreText, tone, dimension: review.plan.focusDimension };
}

/* ============================== 待补测态（409 PROFILE_INCOMPLETE） ============================== */

/** 409 待补测态映射（D35：未知维度不参与主攻排序，先补测）——命中返回引导文案，其他错误码/缺失返回 null */
export function planPendingHintFor(errorCode: string | null | undefined): string | null {
  if (errorCode !== "PROFILE_INCOMPLETE") return null;
  return "先完成基线测评，八维能力点亮后，每周一将为你生成主攻方向。";
}

/* ============================== 首页悬挂计划卡（屏 1） ============================== */

/** 加深/撤销附注（大厅计划条底部说明文案；拒绝后本周不再重复推荐，BR-V2-2） */
export const DEEPEN_FREE_TEXT = "拒绝后暂停本周计划推荐；自适应选题仍可能涉及该维度，可随时撤销。";

/** 首页悬挂卡视图（屏 1：标题 + 理由前置 + 进度条） */
export interface HangingCardView {
  title: string;
  /** 选择理由（前置展示，自适应价值显性化） */
  body: string;
  progressText: string;
  /** 进度条比例（completedDays / 5 个工作日） */
  ratio: number;
}

/** 悬挂卡映射：仅 active 计划且进度在时悬挂；rejected/completed/无计划/无进度返回 null（不悬挂） */
export function hangingCardFor(
  plan: TrainingPlanView | null,
  progress: PlanProgressView | null,
): HangingCardView | null {
  if (!plan || plan.status !== "active" || !progress) return null;
  return {
    title: `本周主攻「${plan.focusDimension}」`,
    body: plan.reason,
    progressText: `本周已完成 ${progress.completedDays} 天`,
    ratio: Math.min(1, Math.max(0, progress.completedDays / 5)),
  };
}
