"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { CurrentTrainingCard } from "@/app/training/current-training-card";
import { sidebarStageText } from "@/app/training/view-model";
import type { DashboardView } from "@/server/modules/dashboard/contract";

import { fetchDashboard } from "./api";
import { HomeShell } from "./home-shell";
import {
  greetingByHour,
  greetingSubline,
  relativeDayText,
  scorePercent,
  trendMark,
  weekSegmentClass,
} from "./view-model";

/**
 * 首页仪表盘交互主体（P1 / T08：US-002，原型 B 屏 1）。
 * 布局：问候行 + 统计条（连续天数、本周 n/7 分段）→ 左列「当前训练」三态卡 +
 * 「最近一条诊断」引用卡，右列「能力总览」卡（条形 + 待解锁虚态）。
 * 「当前训练」卡与产品训练大厅同一张共享组件、同一判定数据源（T26 / D28）；
 * 四卡数据独立装配：单卡为 null 渲染空态虚线卡，不拖垮整页（T08 失败与回滚约定）。
 * 视觉基准：#F5F6F8 浅灰底、白色卡片、主色 #2563EB。
 */

const CARD =
  "rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_12px_32px_-20px_rgba(16,24,40,0.16)]";
const EMPTY_CARD =
  "rounded-2xl border border-dashed border-[#CBD5E3] bg-[#FBFCFE] p-8 text-center";
const PRIMARY_BTN =
  "inline-flex items-center gap-2 rounded-xl bg-[#2563EB] px-6 py-3 text-sm font-semibold text-white shadow-[0_8px_18px_-8px_rgba(37,99,235,0.65)] transition-all hover:-translate-y-px hover:bg-[#1D4ED8]";

export function HomeDashboard() {
  const [view, setView] = useState<DashboardView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 问候语依赖客户端时区，挂载后再计算，避免 SSR/客户端不一致
  const [greeting, setGreeting] = useState("你好");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setView(await fetchDashboard());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "加载失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 首屏加载延迟到 effect 同步阶段之后执行，避免同步 setState 引发级联渲染
    const timer = setTimeout(() => {
      setGreeting(greetingByHour(new Date().getHours()));
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const streakDays = view?.stats?.streakDays ?? 0;
  // 侧栏「今日状态」与大厅同一口径（T26 / D28）：三态卡数据源 → sidebarStageText
  const stageText =
    loading && !view
      ? "加载中"
      : view?.currentTraining
        ? sidebarStageText(view.currentTraining)
        : "待开始";

  return (
    <HomeShell stageText={stageText} streakDays={streakDays}>
      <div className="mx-auto w-full max-w-6xl">
        {loading && !view ? <LoadingView /> : null}

        {loadError ? (
          <div className={`${CARD} p-10 text-center`}>
            <p className="text-sm text-[#475569]">{loadError}</p>
            <button type="button" onClick={() => void load()} className={`${PRIMARY_BTN} mt-5`}>
              重新加载
            </button>
          </div>
        ) : null}

        {view ? (
          <>
            {/* 问候行 + 统计条 */}
            <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold tracking-wide">{greeting}，回到训练场。</h1>
                <p className="mt-2 text-[13px] text-[#64748B]">
                  <b className="font-semibold text-[#2563EB]">{greetingSubline(streakDays)}</b>
                  <span className="mx-2 text-[#CBD5E1]">·</span>
                  保持节奏，每天一道真实产品案例
                </p>
              </div>
              {view.stats ? (
                <div className="flex items-center gap-5 rounded-2xl border border-[#E9EDF4] bg-white px-6 py-3.5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                  <div className="flex flex-col gap-1">
                    <div className="text-[22px] leading-none font-bold">
                      {view.stats.streakDays}
                      <span className="ml-0.5 text-xs font-medium text-[#94A3B8]">天</span>
                    </div>
                    <div className="text-xs text-[#64748B]">连续训练</div>
                  </div>
                  <div className="h-8 w-px bg-[#E9EDF4]" />
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-4 text-xs text-[#64748B]">
                      <span>本周</span>
                      <b className="text-[13px] font-bold text-[#0F172A]">
                        {view.stats.weekTrainedCount}/7
                      </b>
                    </div>
                    <div className="flex gap-1">
                      {view.stats.weekDays.map((day) => (
                        <span
                          key={day.dateKey}
                          className={weekSegmentClass(day)}
                          title={day.dateKey}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-[#CBD5E3] bg-[#FBFCFE] px-6 py-4 text-xs text-[#94A3B8]">
                  统计数据暂时不可用
                </div>
              )}
            </header>

            <div className="grid items-stretch gap-6 xl:grid-cols-[1.55fr_1fr]">
              <div className="flex min-w-0 flex-col gap-6">
                <CurrentTrainingSlot view={view} onRetry={() => void load()} onChanged={() => void load()} />
                <DiagnosisCard view={view} />
              </div>
              <AbilityCard view={view} />
            </div>
          </>
        ) : null}
      </div>
    </HomeShell>
  );
}

/** 加载骨架（克制留白，与今日训练页同一原则） */
function LoadingView() {
  return (
    <div className="grid items-stretch gap-6 xl:grid-cols-[1.55fr_1fr]">
      <div className="flex flex-col gap-6">
        <div className={`${CARD} h-80 animate-pulse bg-[#EDF1F7]`} />
        <div className={`${CARD} h-32 animate-pulse bg-[#EDF1F7]`} />
      </div>
      <div className={`${CARD} h-96 animate-pulse bg-[#EDF1F7]`} />
    </div>
  );
}

/**
 * 「当前训练」卡位（T26 / D28①）：与产品训练大厅同一张共享三态卡，
 * 内容与动作逐字一致；currentTraining 为 null（加载失败降级）时按 T08 约定渲染空态虚线卡。
 * onChanged（T38 / D40①）：「重启训练」终止成功后重取仪表盘载荷，卡片回未开始态
 *（复用 load：已有 view 时重取不闪骨架屏）。
 */
function CurrentTrainingSlot({
  view,
  onRetry,
  onChanged,
}: {
  view: DashboardView;
  onRetry: () => void;
  onChanged: () => void;
}) {
  if (!view.currentTraining) {
    return (
      <section className={`${EMPTY_CARD} flex-1`}>
        <h2 className="text-base font-bold text-[#7A8AA3]">今日训练暂未就绪</h2>
        <p className="mt-2 text-xs text-[#A6B2C6]">题库准备中或加载失败，请稍后再试。</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 text-xs font-medium text-[#2563EB] hover:underline"
        >
          重新加载
        </button>
      </section>
    );
  }
  return <CurrentTrainingCard current={view.currentTraining} onChanged={onChanged} />;
}

/** 最近一条诊断引用卡（session_feedback.top_issue_text，截断展示） */
function DiagnosisCard({ view }: { view: DashboardView }) {
  const diagnosis = view.latestDiagnosis;
  return (
    <section className={`${CARD} relative overflow-hidden p-6`}>
      <span
        aria-hidden
        className="pointer-events-none absolute -top-6 right-4 font-serif text-[110px] leading-none text-[#EAF1FD] select-none"
      >
        “
      </span>
      <div className="mb-3 text-[11px] font-bold tracking-[0.14em] text-[#7C8AA5]">
        最近一条诊断
      </div>
      {diagnosis ? (
        <>
          <blockquote className="relative font-serif text-[15px] leading-loose text-[#22334E]">
            「{diagnosis.text}」
          </blockquote>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs text-[#94A3B8]">
              —— {relativeDayText(diagnosis.dateKey, view.todayDateKey)}
            </span>
            <Link
              href={`/training/feedback/${diagnosis.sessionId}`}
              className="text-xs font-medium text-[#2563EB] hover:underline"
            >
              查看训练反馈 →
            </Link>
          </div>
        </>
      ) : (
        <p className="relative rounded-lg border border-dashed border-[#E2E8F0] bg-[#FAFBFD] px-4 py-3 text-xs leading-relaxed text-[#9AA7BC]">
          完成一次训练后，这里会展示 AI 给你的最近一条诊断。
        </p>
      )}
    </section>
  );
}

/** 能力总览卡：已观测维度条形 + 分数，未观测「待解锁」虚态，n/8 徽标 */
function AbilityCard({ view }: { view: DashboardView }) {
  const ability = view.ability;
  if (!ability) {
    return (
      <section className={EMPTY_CARD}>
        <h3 className="text-base font-bold text-[#7A8AA3]">能力总览暂时不可用</h3>
        <p className="mt-2 text-xs text-[#A6B2C6]">画像数据加载失败，不影响今日训练。</p>
      </section>
    );
  }

  return (
    <section className={`${CARD} flex flex-col p-6`}>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h3 className="text-base font-bold">能力总览</h3>
          <p className="mt-1 text-xs text-[#94A3B8]">{ability.totalCount} 个维度 · 随训练持续更新</p>
        </div>
        <span className="shrink-0 rounded-full border border-[#D9E7FD] bg-[#EFF5FF] px-3 py-1 text-xs font-semibold text-[#1D4ED8]">
          {ability.unlockedCount}/{ability.totalCount} 已解锁
        </span>
      </div>

      {ability.observed.length > 0 ? (
        <div className="mb-5 flex flex-col gap-4">
          {ability.observed.map((bar) => {
            const mark = trendMark(bar.trend);
            return (
              <div key={bar.dimension} className="grid grid-cols-[88px_1fr_44px] items-center gap-3">
                <span className="text-[13px] text-[#334155]">{bar.dimension}</span>
                <div className="h-[9px] overflow-hidden rounded-md bg-[#EDF1F7]">
                  <div
                    className="h-full rounded-md bg-gradient-to-r from-[#3B82F6] to-[#2563EB]"
                    style={{ width: `${scorePercent(bar.score)}%` }}
                  />
                </div>
                <span className="text-right text-[13px] font-bold whitespace-nowrap text-[#334155]">
                  {bar.score}
                  {mark ? <span className="ml-0.5 align-top text-[11px] text-[#2563EB]">{mark}</span> : null}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mb-5 rounded-lg bg-[#F8FAFD] px-4 py-3 text-xs leading-relaxed text-[#64748B]">
          完成第一次训练后，这里会出现你的能力条形。
        </p>
      )}

      {ability.unobserved.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-dashed border-[#E2E8F0] pt-4">
          {ability.unobserved.map((dimension) => (
            <div
              key={dimension}
              className="flex items-center gap-2.5 rounded-lg border border-dashed border-[#D9E0EB] bg-[#FAFBFD] px-3.5 py-2.5"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                className="h-3.5 w-3.5 shrink-0 text-[#A6B2C6]"
              >
                <rect x="3.5" y="7" width="9" height="6" rx="1.5" />
                <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
              </svg>
              <span className="text-[13px] text-[#9AA7BC]">{dimension}</span>
              <span className="ml-auto rounded-full border border-[#E2E8F0] bg-white px-2.5 py-0.5 text-[11px] text-[#A6B2C6]">
                待解锁
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
