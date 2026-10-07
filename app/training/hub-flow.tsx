"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";

import { fetchTrainingHub } from "./api";
import type { HubHistoryItem, TrainingHubView } from "./contract";
import { CurrentTrainingCard } from "./current-training-card";
import { formatScore } from "./feedback/[id]/view-model";
import { TrainingShell } from "./shell";
import {
  formatHubTime,
  historyHrefFor,
  historyStatusFor,
  sidebarStageText,
  type HistoryStatusTone,
} from "./view-model";

/**
 * 产品训练大厅交互主体（T25 / D27 模块主页）。
 * 结构：顶部「当前训练」卡三态（进行中→继续训练 / 未开始→开始今日训练 /
 * 已完成→查看结果+再练一题）+ 下方训练历史列表（加练并入，以徽章区分，D27④），
 * 形成"做题 → 评分 → 再练一题 → 做题"不离开模块的连续闭环。
 * 当前训练卡为共享组件 current-training-card.tsx（T26 / D28①：首页同源渲染，
 * 动作逻辑自持）；本组件只负责大厅载荷加载与历史列表渲染。
 * 数据流：进入即 GET /api/training/hub → 当前卡 + 历史列表；
 * 全部数据→视图判定走 view-model 纯函数，本组件只负责渲染与调用适配层。
 * 视觉以 prototypes/prototype-training-hub.html 为准（产品负责人已拍板）。
 */

const CARD =
  "rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const PRIMARY_BTN =
  "inline-flex items-center gap-2 rounded-xl bg-[#2563EB] px-6 py-3.5 text-sm font-semibold text-white shadow-[0_8px_18px_-8px_rgba(37,99,235,0.65)] transition-all hover:-translate-y-px hover:bg-[#1D4ED8] disabled:cursor-not-allowed disabled:bg-[#94A3B8] disabled:shadow-none disabled:hover:translate-y-0";
const GHOST_BTN =
  "inline-flex items-center gap-2 rounded-xl border border-[#D8DFEA] bg-white px-6 py-3 text-sm font-semibold text-[#334155] transition-colors hover:border-[#3B82F6] hover:bg-[#FAFCFF] hover:text-[#1D4ED8] disabled:cursor-not-allowed disabled:opacity-60";

type Phase = "loading" | "ready" | "error";

export function TrainingHubFlow() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [view, setView] = useState<TrainingHubView | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** 手动重试令牌：递增触发 effect 重新加载 */
  const [retryToken, setRetryToken] = useState(0);
  /** 最近一次加载完成时间：历史行「今天 HH:mm」判定基准（渲染期不取当前时间） */
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    /** 拉取大厅载荷；失败进入错误态（可手动重试） */
    async function load(): Promise<void> {
      try {
        const result = await fetchTrainingHub();
        if (cancelled) return;
        setView(result);
        setLoadedAt(new Date());
        setPhase("ready");
      } catch (error) {
        if (cancelled) return;
        setPhase("error");
        setErrorMessage(error instanceof Error ? error.message : "加载失败，请稍后重试");
      }
    }
    // 首屏加载延迟到 effect 同步阶段之后执行，避免同步 setState 引发级联渲染
    const timer = setTimeout(() => void load(), 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [retryToken]);

  const onRetry = useCallback(() => {
    setErrorMessage(null);
    setPhase("loading");
    setRetryToken((prev) => prev + 1);
  }, []);

  return (
    <TrainingShell
      stageText={view ? sidebarStageText(view.current) : "加载中"}
      streakDays={view?.streakDays ?? 0}
    >
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-5">
          <h1 className="text-[26px] font-bold tracking-wide">产品训练</h1>
          <p className="mt-2 text-[13.5px] text-[#64748B]">每天一个真实产品问题，训练产品判断力</p>
        </header>

        {phase === "loading" ? (
          <>
            <div className={`${CARD} mb-6 h-56 animate-pulse bg-[#EDF1F7]`} />
            <div className={`${CARD} h-80 animate-pulse bg-[#EDF1F7]`} />
          </>
        ) : null}

        {phase === "error" ? (
          <div className={`${CARD} p-10 text-center`}>
            <p className="text-sm text-[#475569]">{errorMessage}</p>
            <button type="button" onClick={onRetry} className={`${PRIMARY_BTN} mt-5`}>
              重新加载
            </button>
          </div>
        ) : null}

        {phase === "ready" && view ? (
          <>
            {/* 卡片自身不带外边距（T26 共享组件）：大厅这里保持原 mb-6 间距，渲染结果不变 */}
            <div className="mb-6">
              <CurrentTrainingCard current={view.current} />
            </div>
            <HistorySection history={view.history} now={loadedAt ?? new Date()} />
          </>
        ) : null}
      </div>
    </TrainingShell>
  );
}

/** 训练历史列表（D27④：加练并入，以徽章区分；基线会话不下发，D26⑦/D27 同口径） */
function HistorySection({ history, now }: { history: HubHistoryItem[]; now: Date }) {
  return (
    <>
      <div className="mx-0.5 mb-3 flex items-baseline gap-3">
        <h2 className="text-[17px] font-bold">训练历史</h2>
        <span className="text-xs text-[#94A3B8]">加练与每日一题同等计入能力画像</span>
      </div>
      <section className={`${CARD} overflow-hidden`}>
        {history.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-[#94A3B8]">
            还没有训练记录——完成第一次今日训练后，这里会列出你的训练轨迹
          </p>
        ) : (
          history.map((item) => <HistoryRow key={item.sessionId} item={item} now={now} />)
        )}
        <div className="flex justify-center border-t border-[#E9EDF4] px-6 py-4">
          {/* 首版分页从简：固定条数，「加载更多」留空实现（任务契约，原型如此） */}
          <button type="button" disabled className={GHOST_BTN}>
            加载更多
          </button>
        </div>
      </section>
    </>
  );
}

/** 历史行状态徽章（原型：已完成绿 / 评分中蓝 / 作答中·追问中灰） */
const STATUS_TONE_CLASS: Record<HistoryStatusTone, string> = {
  done: "border-[#D1FAE5] bg-[#ECFDF5] text-[#047857]",
  scoring: "border-[#D9E7FD] bg-[#EFF5FF] text-[#1D4ED8]",
  doing: "border-[#E6EAF1] bg-[#F1F5F9] text-[#64748B]",
};

/** 单条训练记录行：类型徽章 + 状态徽章 / 案例名 / 能力标签 / 得分摘要与时间；整行可点（进行中回工作台、已完成看回放） */
function HistoryRow({ item, now }: { item: HubHistoryItem; now: Date }) {
  const status = historyStatusFor(item);
  return (
    <Link
      href={historyHrefFor(item)}
      className="flex flex-wrap items-center gap-4 border-b border-[#F0F3F8] px-6 py-4 transition-colors last:border-b-0 hover:bg-[#FAFBFE]"
    >
      <div className="flex min-w-[260px] flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`rounded-[7px] border px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap ${
              item.isExtra
                ? "border-[#D9E7FD] bg-[#EFF5FF] text-[#1D4ED8]"
                : "border-[#D8DFEA] bg-white text-[#64748B]"
            }`}
          >
            {item.isExtra ? "加练" : "每日"}
          </span>
          <span
            className={`rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold whitespace-nowrap ${STATUS_TONE_CLASS[status.tone]}`}
          >
            {status.text}
          </span>
        </div>
        <div className="text-[14.5px] leading-6 font-semibold text-[#1E293B]">{item.caseTitle}</div>
        {item.abilityTags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {item.abilityTags.map((tag) => (
              <span
                key={tag}
                className="rounded-[7px] border border-[#E9EDF3] bg-[#F5F7FA] px-2 py-0.5 text-[11.5px] text-[#475569]"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        {item.scores.length > 0 ? (
          <span className="text-xs whitespace-nowrap text-[#64748B]">
            {item.scores.map((score, index) => (
              <Fragment key={score.dimension}>
                {index > 0 ? <span className="mx-1 text-[#CBD5E1]">·</span> : null}
                {score.dimension}{" "}
                <b className="font-bold text-[#1E293B]">{formatScore(score.effectiveScore)}</b>
              </Fragment>
            ))}
          </span>
        ) : null}
        <span className="text-xs whitespace-nowrap text-[#94A3B8]">
          {formatHubTime(item.startedAt, now)}
        </span>
      </div>
    </Link>
  );
}
