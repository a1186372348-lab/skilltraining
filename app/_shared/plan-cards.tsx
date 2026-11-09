"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { fetchCurrentPlan, fetchPlanReview, pendingHintOf, postPlanAction } from "./plan-api";
import {
  DEEPEN_FREE_TEXT,
  hangingCardFor,
  planWeekDays,
  progressTextFor,
  rejectActionFor,
  reviewCardFor,
  statusLabelFor,
  type PlanDayView,
  type PlanProgressView,
  type ReviewCardView,
  type TrainingPlanView,
} from "./plan-view-model";

/**
 * 周期训练计划卡（T29 切片 5 / F5；视觉参照 docs/v2/v2-prototype-final.html 屏 3 + 屏 1，
 * 设计语言沿用 prototype-b 体系：主色蓝 #2563EB、白卡微阴影、空态虚线卡）。
 *
 * 两个形态：
 * - PlanSection（大厅）：主攻卡（当前分→目标分 + 理由前置 + 排期三态 + 拒绝/撤销）
 *   + 周回顾卡（有回顾时）+ 待补测引导卡（409 PROFILE_INCOMPLETE）；
 * - HangingPlanCard（首页悬挂卡）：标题 + 理由 + 进度条 + 查看计划链接。
 * 降级约定：接口或数据异常 → 不渲染（返回 null），绝不影响主流程（任务契约「失败与回滚」）。
 */

const CARD =
  "rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const GHOST_BTN =
  "rounded-lg border border-[#D8DFEA] bg-white px-3 py-1.5 text-xs font-semibold text-[#64748B] transition-colors hover:border-[#3B82F6] hover:text-[#1D4ED8] disabled:cursor-not-allowed disabled:opacity-60";

/** 状态标签色（生效中蓝 / 已拒绝灰 / 已归档绿） */
const STATUS_TONE_CLASS = {
  active: "border-[#D9E7FD] bg-[#EFF5FF] text-[#1D4ED8]",
  rejected: "border-[#E6EAF1] bg-[#F1F5F9] text-[#64748B]",
  completed: "border-[#D1FAE5] bg-[#ECFDF5] text-[#047857]",
} as const;

/** 数据加载：计划 + 进度 + 周回顾（review 失败不拖垮计划卡——单卡容错惯例同 T08） */
function usePlanData() {
  const [plan, setPlan] = useState<TrainingPlanView | null>(null);
  const [progress, setProgress] = useState<PlanProgressView | null>(null);
  const [review, setReview] = useState<ReviewCardView | null>(null);
  const [pendingHint, setPendingHint] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const current = await fetchCurrentPlan();
      setPlan(current.plan);
      setProgress(current.progress);
      setPendingHint(null);
      try {
        const reviewRes = await fetchPlanReview();
        setReview(reviewCardFor(reviewRes.review));
        if (reviewRes.review?.plan.id === current.plan.id) setPlan(reviewRes.review.plan);
      } catch {
        // 周回顾单卡失败不影响计划卡
      }
    } catch (error) {
      const hint = pendingHintOf(error);
      if (hint) {
        setPendingHint(hint);
      } else {
        setFailed(true); // 其他异常：降级为不展示
      }
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  return { plan, progress, review, pendingHint, failed, reload: load };
}

/** 大厅计划条/计划详情（屏 3 浓缩）：主攻卡 + 排期三态 + 拒绝/撤销 + 周回顾卡 */
export function PlanSection() {
  const { plan, progress, review, pendingHint, failed, reload } = usePlanData();
  const [pendingAction, setPendingAction] = useState(false);
  const [now] = useState(() => new Date()); // 挂载时取一次（渲染期纯净）

  const onRejectAction = useCallback(
    async (action: "reject" | "unreject") => {
      if (pendingAction) return;
      setPendingAction(true);
      try {
        await postPlanAction(action);
        await reload(); // 计划区数据小、频次低：动作后直接重拉保持单一事实源
      } catch {
        // 失败静默：下次进入重试（轻量端点，幂等安全）
      } finally {
        setPendingAction(false);
      }
    },
    [pendingAction, reload],
  );

  if (failed) return null; // 降级：不展示计划卡，绝不影响今日训练主流程
  if (pendingHint) {
    return (
      <section className="rounded-2xl border border-dashed border-[#CBD5E3] bg-[#FBFCFE] p-5 text-sm text-[#64748B]">
        {pendingHint}
      </section>
    );
  }
  if (!plan || !progress) return null;

  const statusLabel = statusLabelFor(plan.status);
  const days = planWeekDays(plan.weekStartDate, now, progress.completedDates);
  const rejectAction = rejectActionFor(plan);

  return (
    <section className={`${CARD} p-6`} data-testid="plan-section">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-bold">本周训练计划</h2>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_TONE_CLASS[statusLabel.tone]}`}
        >
          {statusLabel.label}
        </span>
      </div>

      {/* 主攻卡：当前分 → 目标分 + 理由前置 */}
      <div className="flex items-baseline gap-3">
        <span className="text-3xl leading-none font-bold text-[#12233F]">
          {plan.startScore}
          <span className="ml-0.5 text-xs font-medium text-[#94A3B8]">分</span>
        </span>
        <span className="text-xs text-[#94A3B8]">→</span>
        <span className="text-lg font-bold text-[#2563EB]">
          {plan.targetScore}
          <span className="ml-0.5 text-xs font-medium text-[#94A3B8]">目标</span>
        </span>
        <span className="rounded-[7px] border border-[#FDE68A] bg-[#FFFBEB] px-2 py-0.5 text-[11px] font-semibold text-[#B45309]">
          {plan.focusDimension} · 弱项
        </span>
      </div>
      <p className="mt-2 text-xs leading-5 text-[#475569]">{plan.reason}</p>

      {/* 排期三态：周一至周五（已完成蓝 / 今日高亮 / 未来灰） */}
      <div className="mt-4 flex items-center gap-1.5">
        {days.map((day) => (
          <PlanDayCell key={day.dateLabel} day={day} />
        ))}
      </div>
      <p className="mt-2 text-[11px] text-[#94A3B8]">{progressTextFor(progress)}</p>

      {/* 拒绝/撤销（BR-V2-2 / D33②：拒绝后本周不再重复推荐） */}
      {rejectAction ? (
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-[#F0F3F8] pt-4">
          <span className="text-[11px] leading-4 text-[#94A3B8]">{DEEPEN_FREE_TEXT}</span>
          <button
            type="button"
            disabled={pendingAction}
            onClick={() => void onRejectAction(rejectAction.action)}
            className={GHOST_BTN}
          >
            {pendingAction ? "提交中…" : rejectAction.label}
          </button>
        </div>
      ) : null}

      {/* 周回顾卡（周日生成后显示） */}
      {review ? <ReviewCard review={review} /> : null}
    </section>
  );
}

/** 排期日格：done 蓝 / today 高亮蓝边 / future 灰虚 */
function PlanDayCell({ day }: { day: PlanDayView }) {
  return (
    <div
      className={`flex flex-1 flex-col items-center gap-0.5 rounded-lg border px-2 py-2 ${
        day.state === "done"
          ? "border-[#D9E7FD] bg-[#EFF5FF]"
          : day.isToday
            ? "border-[#2563EB] bg-white shadow-[0_2px_8px_rgba(37,99,235,0.15)]"
            : "border-dashed border-[#E2E8F0] bg-[#F8FAFD]"
      }`}
    >
      <span className={`text-[11px] font-semibold ${day.state === "done" ? "text-[#1D4ED8]" : day.isToday ? "text-[#2563EB]" : "text-[#94A3B8]"}`}>
        {day.dateLabel}
      </span>
      <span className={`text-[10px] ${day.isToday ? "font-bold text-[#2563EB]" : "text-[#94A3B8]"}`}>
        {day.weekdayLabel}
        {day.isToday ? " · 今天" : ""}
      </span>
    </div>
  );
}

/** 周回顾卡（屏 3 右栏：完成天数 + 主攻维度有效分变化） */
function ReviewCard({ review }: { review: ReviewCardView }) {
  const toneClass =
    review.tone === "up"
      ? "text-[#047857]"
      : review.tone === "down"
        ? "text-[#B45309]"
        : "text-[#64748B]";
  return (
    <div className="mt-4 rounded-xl border border-[#E9EDF4] bg-[#F8FAFD] p-4">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] font-bold tracking-[0.1em] text-[#7C8AA5]">
          {review.title}
        </span>
      </div>
      <p className="text-sm font-semibold text-[#12233F]">{review.daysText}</p>
      <p className={`mt-1 text-xs leading-5 ${toneClass}`}>{review.scoreText}</p>
    </div>
  );
}

/** 首页悬挂计划卡（屏 1）：标题 + 理由前置 + 进度条 + 查看计划链接；异常/无计划不渲染 */
export function HangingPlanCard() {
  const [card, setCard] = useState<ReturnType<typeof hangingCardFor>>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const current = await fetchCurrentPlan();
          if (!cancelled) setCard(hangingCardFor(current.plan, current.progress));
        } catch {
          if (!cancelled) setFailed(true); // 降级：不悬挂
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (failed || !card) return null;
  return (
    <Link
      href="/training"
      className={`${CARD} block p-5 transition-shadow hover:shadow-[0_4px_12px_rgba(37,99,235,0.12)]`}
      data-testid="hanging-plan-card"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-[7px] border border-[#D9E7FD] bg-[#EFF5FF] px-2 py-0.5 text-[11px] font-semibold text-[#1D4ED8]">
          本周计划
        </span>
        <span className="text-sm font-bold text-[#12233F]">{card.title}</span>
      </div>
      <p className="text-xs leading-5 text-[#475569]">{card.body}</p>
      <div className="mt-3 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#E2E8F0]">
          <div
            className="h-full rounded-full bg-[#2563EB] transition-[width]"
            style={{ width: `${Math.round(card.ratio * 100)}%` }}
          />
        </div>
        <span className="text-[11px] whitespace-nowrap text-[#94A3B8]">{card.progressText}</span>
        <span className="text-[11px] font-semibold text-[#2563EB]">查看计划 ▸</span>
      </div>
    </Link>
  );
}
