"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import type { HubCurrentCard, HubInProgressCard } from "./contract";
import { formatScore } from "./feedback/[id]/view-model";
import { fetchTodaySession, startExtraSession } from "./session/api";
import type { TodayView } from "./session/contract";
import {
  actionNoteFor,
  continueActionFor,
  currentBadgeText,
  formatHubDateKey,
  progressLineFor,
} from "./view-model";

/**
 * 「当前训练」三态卡（T26 / D28①：从大厅 hub-flow 抽出的共享组件，
 * 大厅与首页同源渲染同一组件，杜绝两处文案/结构漂移）。
 * 三态：进行中→继续训练 / 未开始→开始今日训练 / 已完成→查看结果+再练一题（D27②）。
 * 组件自持全部动作逻辑：开始今日训练 / 再练一题的 pending、行内错误与跳转
 * （两动作不同时可见，共用一条行内错误）；「查看结果 / 继续训练」为纯 Link。
 * 卡片自身不带外边距——间距由所在页面布局（大厅 mb-6 / 首页左列 gap）决定。
 */

const CARD =
  "rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const PRIMARY_BTN =
  "inline-flex items-center gap-2 rounded-xl bg-[#2563EB] px-6 py-3.5 text-sm font-semibold text-white shadow-[0_8px_18px_-8px_rgba(37,99,235,0.65)] transition-all hover:-translate-y-px hover:bg-[#1D4ED8] disabled:cursor-not-allowed disabled:bg-[#94A3B8] disabled:shadow-none disabled:hover:translate-y-0";
const GHOST_BTN =
  "inline-flex items-center gap-2 rounded-xl border border-[#D8DFEA] bg-white px-6 py-3 text-sm font-semibold text-[#334155] transition-colors hover:border-[#3B82F6] hover:bg-[#FAFCFF] hover:text-[#1D4ED8] disabled:cursor-not-allowed disabled:opacity-60";

/** 「当前训练」卡三态分派 + 动作持有（D27② / D28①） */
export function CurrentTrainingCard({ current }: { current: HubCurrentCard }) {
  const router = useRouter();
  /** 开始今日训练 / 再练一题的进行中标记与行内错误（两动作不同时可见，共用一条错误） */
  const [todayPending, setTodayPending] = useState(false);
  const [extraPending, setExtraPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * 开始今日训练（D27③ 每日首推仪式感）：GET /api/training/today（get-or-create）拿 sessionId 后直达工作台；
   * T17a / D19 门禁：基线未完成时 today 返回基线会话（kind 窄化读取，同 BaselineFlow.viewKind），改跳 /baseline。
   */
  const onStartToday = useCallback(async () => {
    if (todayPending) return;
    setTodayPending(true);
    setActionError(null);
    try {
      const today = await fetchTodaySession();
      if (!today) throw new Error("今日训练暂未就绪，请稍后重试");
      if ((today as TodayView & { kind?: string }).kind === "baseline") {
        router.push("/baseline");
        return;
      }
      router.push(`/training/session/${today.sessionId}`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "进入训练失败，请重试");
    } finally {
      setTodayPending(false);
    }
  }, [todayPending, router]);

  /** 再练一题（T21 / D3）：创建/复用加练会话，拿 sessionId 直达新工作台 */
  const onStartExtra = useCallback(async () => {
    if (extraPending) return;
    setExtraPending(true);
    setActionError(null);
    try {
      const res = await startExtraSession();
      router.push(`/training/session/${res.sessionId}`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "创建加练失败，请重试");
    } finally {
      setExtraPending(false);
    }
  }, [extraPending, router]);

  if (current.kind === "in_progress") {
    return <InProgressCard current={current} />;
  }
  if (current.kind === "not_started") {
    return (
      <NotStartedCard
        current={current}
        pending={todayPending}
        error={actionError}
        onStart={() => void onStartToday()}
      />
    );
  }
  return (
    <CompletedCard
      current={current}
      pending={extraPending}
      error={actionError}
      onStartExtra={() => void onStartExtra()}
    />
  );
}

/** 状态徽章底色（原型：蓝=进行中/评分中、绿=已完成、灰=今日/作答中） */
const BADGE_TONE_CLASS = {
  blue: "border-[#D9E7FD] bg-[#EFF5FF] text-[#1D4ED8]",
  green: "border-[#D1FAE5] bg-[#ECFDF5] text-[#047857]",
  grey: "border-[#E6EAF1] bg-[#F1F5F9] text-[#64748B]",
} as const;

function Badge({ tone, children }: { tone: keyof typeof BADGE_TONE_CLASS; children: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap ${BADGE_TONE_CLASS[tone]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

/** 状态①：有进行中的训练——标题 + 进度提示条 +「继续训练」（评分中改跳反馈页） */
function InProgressCard({ current }: { current: HubInProgressCard }) {
  const action = continueActionFor(current);
  return (
    <section className={`${CARD} p-8`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs font-bold tracking-[0.16em] text-[#2563EB]">当前训练</span>
        <Badge tone="blue">{currentBadgeText(current)}</Badge>
      </div>
      <h2 className="mb-4 text-2xl leading-snug font-bold">{current.caseTitle}</h2>
      <div className="mb-6 flex items-center gap-2 rounded-xl border border-[#D9E7FD] bg-[#EFF5FF] px-4 py-3 text-[13px] text-[#3D5A90]">
        <span className="shrink-0 text-xs text-[#2563EB]">◆</span>
        {progressLineFor(current.stage)}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Link href={action.href} className={PRIMARY_BTN}>
          {action.label}
          <span className="text-xs">▸</span>
        </Link>
        <span className="text-xs text-[#94A3B8]">{actionNoteFor(current.stage)}</span>
      </div>
    </section>
  );
}

/** 状态②：今日训练未开始——日期大标题 +「开始今日训练」（调 today 接口拿 sessionId 直达工作台） */
function NotStartedCard({
  current,
  pending,
  error,
  onStart,
}: {
  current: HubCurrentCard & { kind: "not_started" };
  pending: boolean;
  error: string | null;
  onStart: () => void;
}) {
  return (
    <section className={`${CARD} p-8`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs font-bold tracking-[0.16em] text-[#2563EB]">当前训练</span>
        <Badge tone="grey">今日训练</Badge>
      </div>
      <h2 className="mb-2 text-2xl font-bold">{formatHubDateKey(current.dateKey)}</h2>
      <p className="mb-6 text-[13.5px] text-[#64748B]">今天的训练已准备好，约 15 分钟</p>
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" onClick={onStart} disabled={pending} className={PRIMARY_BTN}>
          {pending ? "进入中…" : "开始今日训练"}
          <span className="text-xs">▸</span>
        </button>
        <span className="text-xs text-[#94A3B8]">作答后，AI 产品总监将追问并给出诊断</span>
        {error ? <span className="text-xs text-red-600">{error}</span> : null}
      </div>
    </section>
  );
}

/** 状态③：今日训练已完成——案例标题 + ≤3 条维度得分条 +「查看结果 / 再练一题」 */
function CompletedCard({
  current,
  pending,
  error,
  onStartExtra,
}: {
  current: HubCurrentCard & { kind: "completed" };
  pending: boolean;
  error: string | null;
  onStartExtra: () => void;
}) {
  return (
    <section className={`${CARD} p-8`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs font-bold tracking-[0.16em] text-[#2563EB]">当前训练</span>
        <Badge tone="green">今日训练已完成</Badge>
      </div>
      <h2 className="mb-4 text-2xl leading-snug font-bold">{current.caseTitle}</h2>
      {current.scores.length > 0 ? (
        <div className="mb-6 flex flex-wrap gap-3">
          {current.scores.map((score) => (
            <div
              key={score.dimension}
              className="min-w-[130px] flex-1 rounded-xl border border-[#EEF2F8] bg-[#F8FAFD] px-4 py-3.5"
            >
              <div className="mb-1 text-xs text-[#64748B]">{score.dimension}</div>
              <div className="text-[22px] leading-none font-bold">
                {formatScore(score.effectiveScore)}
                <span className="ml-0.5 text-xs font-medium text-[#94A3B8]">分</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <Link href={`/training/feedback/${current.sessionId}`} className={GHOST_BTN}>
          查看结果
        </Link>
        <button type="button" onClick={onStartExtra} disabled={pending} className={PRIMARY_BTN}>
          {pending ? "创建中…" : "再练一题"}
          <span className="text-xs">▸</span>
        </button>
        {error ? <span className="text-xs text-red-600">{error}</span> : null}
      </div>
    </section>
  );
}
