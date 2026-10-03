"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { fetchHistoryList } from "./api";
import type { HistoryListItem, HistoryListView } from "./contract";
import { HistoryShell } from "./shell";
import {
  formatHistoryDate,
  hasNextPage,
  hasPrevPage,
  paginationInfoText,
  scoreSummaryText,
  sessionStateText,
  trainingCountText,
} from "./view-model";

/**
 * 训练历史列表页交互主体（P5 / T10：US-009）。
 * 数据流：进入即 GET /api/history（按日期倒序 + 分页元数据）→ 卡片列表；
 * 空态虚线卡引导去 /today；分页控件翻页。
 * 全部数据→视图判定走 view-model 纯函数，本组件只负责渲染与调用适配层。
 * 视觉以 prototypes/prototype-b-dashboard.html 为基准，复用侧边栏外壳模式。
 */

const CARD =
  "rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const PRIMARY_BTN =
  "rounded-xl bg-[#2563EB] px-6 py-3 text-sm font-bold text-white shadow-[0_4px_12px_rgba(37,99,235,0.25)] transition-colors hover:bg-[#1D4ED8] disabled:cursor-not-allowed disabled:bg-[#94A3B8] disabled:shadow-none";
const PAGE_BTN =
  "rounded-xl border border-[#D8E0EC] bg-white px-4 py-2 text-sm font-semibold text-[#475569] transition-colors hover:border-[#2563EB] hover:text-[#2563EB] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[#D8E0EC] disabled:hover:text-[#475569]";

type Phase = "loading" | "ready" | "error";

export function HistoryFlow() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [page, setPage] = useState(1);
  const [view, setView] = useState<HistoryListView | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** 手动重试令牌：递增触发 effect 重新加载 */
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    /** 拉取一页历史；失败进入错误态（可手动重试） */
    async function load(): Promise<void> {
      try {
        const result = await fetchHistoryList(page);
        if (cancelled) return;
        setView(result);
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
  }, [page, retryToken]);

  const onRetry = useCallback(() => {
    setErrorMessage(null);
    setPhase("loading");
    setRetryToken((prev) => prev + 1);
  }, []);

  const onPageChange = useCallback((nextPage: number) => {
    setPhase("loading");
    setPage(nextPage);
  }, []);

  return (
    <HistoryShell countText={view ? trainingCountText(view.pagination.total) : "加载中"}>
      <div className="mx-auto w-full max-w-4xl">
        <header className="mb-6 flex flex-wrap items-center gap-3">
          <span className="text-xs font-bold tracking-[0.16em] text-[#2563EB]">训练历史</span>
          {view ? (
            <span className="rounded-full border border-[#E9EDF4] bg-white px-3 py-1 text-xs text-[#475569]">
              {paginationInfoText(view.pagination)}
            </span>
          ) : null}
        </header>

        {phase === "loading" ? (
          <div className={`${CARD} animate-pulse p-10 text-center text-sm text-[#94A3B8]`}>
            正在加载训练记录…
          </div>
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
          view.items.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="flex flex-col gap-4 pb-6">
              {view.items.map((item) => (
                <HistoryCard key={item.sessionId} item={item} />
              ))}
              <PaginationBar view={view} onPageChange={onPageChange} />
            </div>
          )
        ) : null}
      </div>
    </HistoryShell>
  );
}

/** 空态：虚线卡引导去今日训练（原型 B 空态语言） */
function EmptyState() {
  return (
    <div className="rounded-2xl border-2 border-dashed border-[#D8E0EC] bg-white/60 p-12 text-center">
      <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-[#EFF5FF] text-lg text-[#2563EB]">
        ✎
      </div>
      <h3 className="text-lg font-bold">还没有训练记录</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#475569]">
        完成第一次今日训练后，这里会按日期列出每次训练的案例、答案、提示使用、
        追问记录与最终反馈，方便你随时回看成长轨迹。
      </p>
      <Link href="/today" className={`${PRIMARY_BTN} mt-6 inline-block`}>
        去今日训练
      </Link>
    </div>
  );
}

/** 单条训练记录卡：日期 + 状态徽标 / 案例名 / 训练重点 / 有效分摘要，整卡可点进详情 */
function HistoryCard({ item }: { item: HistoryListItem }) {
  const finished = item.state === "scored";
  return (
    <Link
      href={`/history/${item.sessionId}`}
      className={`${CARD} block p-6 transition-shadow hover:shadow-[0_8px_24px_-8px_rgba(37,99,235,0.18)]`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-[#475569]">{formatHistoryDate(item.date)}</span>
        <span
          className={`rounded-full px-2.5 py-0.5 font-semibold ${
            finished ? "bg-[#ECFDF5] text-[#047857]" : "bg-[#EFF5FF] text-[#2563EB]"
          }`}
        >
          {sessionStateText(item.state)}
        </span>
        {item.isExtra ? (
          <span className="rounded-full bg-[#F5F6F8] px-2.5 py-0.5 text-[#64748B]">加练</span>
        ) : null}
        <span className="ml-auto text-[#94A3B8]">查看回放 →</span>
      </div>
      <h3 className="mt-3 text-[15px] leading-6 font-bold text-[#0F172A]">{item.caseTitle}</h3>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {item.abilityTags.map((tag) => (
          <span
            key={tag}
            className="rounded-full border border-[#D9E7FD] bg-[#F7FAFF] px-2.5 py-0.5 text-xs text-[#2563EB]"
          >
            {tag}
          </span>
        ))}
      </div>
      <p className="mt-3 text-xs text-[#64748B]">
        {finished ? scoreSummaryText(item.scores) : "本次训练尚未完成评分"}
      </p>
    </Link>
  );
}

/** 分页条：上一页 / 下一页 + 页码信息 */
function PaginationBar({
  view,
  onPageChange,
}: {
  view: HistoryListView;
  onPageChange: (page: number) => void;
}) {
  const { page, totalPages } = view.pagination;
  return (
    <div className="flex items-center justify-between pt-2">
      <button
        type="button"
        className={PAGE_BTN}
        disabled={!hasPrevPage(page)}
        onClick={() => onPageChange(page - 1)}
      >
        ← 上一页
      </button>
      <span className="text-xs text-[#94A3B8]">{paginationInfoText(view.pagination)}</span>
      <button
        type="button"
        className={PAGE_BTN}
        disabled={!hasNextPage(page, totalPages)}
        onClick={() => onPageChange(page + 1)}
      >
        下一页 →
      </button>
    </div>
  );
}
