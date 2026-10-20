"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import type { HubCurrentCard, HubInProgressCard } from "./contract";
import { formatScore } from "./feedback/[id]/view-model";
import { abandonSession, fetchTodaySession, startExtraSession, ApiError } from "./session/api";
import type { TodayView } from "./session/contract";
import {
  actionNoteFor,
  canRestartFor,
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
 * T38 / D40①：进行中态「继续训练」右侧加「重启训练」（次级样式，评分中不展示）——
 * 两步内联确认（点击 →「丢弃当前作答并重启？」确认/取消）→ POST abandon →
 * 经 onChanged 回调让父级重取数据，卡片回到未开始态；父级未接回调时仅复位本地态。
 * 卡片自身不带外边距——间距由所在页面布局（大厅 mb-6 / 首页左列 gap）决定。
 */

const CARD =
  "rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const PRIMARY_BTN =
  "inline-flex items-center gap-2 rounded-xl bg-[#2563EB] px-6 py-3.5 text-sm font-semibold text-white shadow-[0_8px_18px_-8px_rgba(37,99,235,0.65)] transition-all hover:-translate-y-px hover:bg-[#1D4ED8] disabled:cursor-not-allowed disabled:bg-[#94A3B8] disabled:shadow-none disabled:hover:translate-y-0";
const GHOST_BTN =
  "inline-flex items-center gap-2 rounded-xl border border-[#D8DFEA] bg-white px-6 py-3 text-sm font-semibold text-[#334155] transition-colors hover:border-[#3B82F6] hover:bg-[#FAFCFF] hover:text-[#1D4ED8] disabled:cursor-not-allowed disabled:opacity-60";
/** 「确认重启」小按钮（破坏性感知但克制：红色实心小尺寸，嵌在确认条内） */
const DANGER_BTN =
  "rounded-lg bg-[#DC2626] px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#B91C1C] disabled:cursor-not-allowed disabled:bg-[#FCA5A5]";

/** 「当前训练」卡三态分派 + 动作持有（D27② / D28①）；onChanged：动作改变会话后请父级重取（T38） */
export function CurrentTrainingCard({
  current,
  onChanged,
}: {
  current: HubCurrentCard;
  /** T38 / D40①：终止成功后回调（父级为客户端取数，重取后卡片回到未开始态） */
  onChanged?: () => void;
}) {
  const router = useRouter();
  /** 开始今日训练 / 再练一题的进行中标记与行内错误（两动作不同时可见，共用一条错误） */
  const [todayPending, setTodayPending] = useState(false);
  const [extraPending, setExtraPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * 开始今日训练（D27③ 每日首推仪式感）：GET /api/training/today（get-or-create）拿 sessionId 后直达工作台；
   * T17a / D19 门禁：基线未完成时 today 返回基线会话（kind 窄化读取，同 BaselineFlow.viewKind），改跳 /baseline；
   * T36 / D38 边界：基线全部已作答待评分时 today 返回 409 BASELINE_SCORING_PENDING，静默跳 /baseline 收尾页。
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
      // 基线评分生成中：不显示错误，直接回基线页（收尾页轮询等待揭晓）
      if (error instanceof ApiError && error.code === "BASELINE_SCORING_PENDING") {
        router.push("/baseline");
        return;
      }
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
      // T36 / D38：基线未完成 → 挡回基线测评（服务端 409 BASELINE_REQUIRED）
      if (error instanceof ApiError && error.code === "BASELINE_REQUIRED") {
        router.push("/baseline");
        return;
      }
      setActionError(error instanceof Error ? error.message : "创建加练失败，请重试");
    } finally {
      setExtraPending(false);
    }
  }, [extraPending, router]);

  if (current.kind === "in_progress") {
    return <InProgressCard current={current} onChanged={onChanged} />;
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

/** 状态①：有进行中的训练——标题 + 进度提示条 +「继续训练」（评分中改跳反馈页）+「重启训练」（T38 / D40①） */
function InProgressCard({
  current,
  onChanged,
}: {
  current: HubInProgressCard;
  onChanged?: () => void;
}) {
  const action = continueActionFor(current);
  /** T38：重启训练两步内联确认（确认中标记 + 终止请求 pending + 行内错误） */
  const [confirming, setConfirming] = useState(false);
  const [abandonPending, setAbandonPending] = useState(false);
  const [abandonError, setAbandonError] = useState<string | null>(null);
  // D40④：评分中已交终答（服务端一律 409），重启入口不展示
  const canRestart = canRestartFor(current.stage);

  /** 确认重启：调终止接口 → 父级重取回未开始态；失败就地报错可重试 */
  const onConfirmRestart = useCallback(async () => {
    if (abandonPending) return;
    setAbandonPending(true);
    setAbandonError(null);
    try {
      await abandonSession(current.sessionId);
      if (onChanged) {
        onChanged(); // 终止成功：卡片随父级重取回到未开始态（本地态随重渲染重置）
      } else {
        setConfirming(false);
        setAbandonPending(false);
      }
    } catch (error) {
      setAbandonError(error instanceof Error ? error.message : "终止失败，请重试");
      setAbandonPending(false);
    }
  }, [abandonPending, current.sessionId, onChanged]);

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
        {canRestart && !confirming ? (
          <button
            type="button"
            onClick={() => {
              setConfirming(true);
              setAbandonError(null);
            }}
            className={GHOST_BTN}
          >
            重启训练
          </button>
        ) : null}
        {canRestart && confirming ? (
          <span className="inline-flex flex-wrap items-center gap-3 rounded-xl border border-[#FDE2E2] bg-[#FFF8F8] px-4 py-2.5">
            <span className="text-[13px] font-medium text-[#B91C1C]">丢弃当前作答并重启？</span>
            <button
              type="button"
              onClick={() => void onConfirmRestart()}
              disabled={abandonPending}
              className={DANGER_BTN}
            >
              {abandonPending ? "终止中…" : "确认重启"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setAbandonError(null);
              }}
              disabled={abandonPending}
              className="text-xs font-semibold text-[#64748B] transition-colors hover:text-[#1D4ED8] disabled:cursor-not-allowed disabled:opacity-60"
            >
              取消
            </button>
          </span>
        ) : null}
        {!confirming ? (
          <span className="text-xs text-[#94A3B8]">{actionNoteFor(current.stage)}</span>
        ) : null}
        {abandonError ? <span className="text-xs text-red-600">{abandonError}</span> : null}
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
