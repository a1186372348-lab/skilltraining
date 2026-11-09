"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useStageOverview } from "@/app/_shared/stage-badge/stage-provider";
import { StageApiError, startRetest } from "./api";
import type { StageDimension, StageKind, StageOverview } from "./contract";
import { dimensionStatusText, stageName, stageReason, timelineText } from "./view-model";

const CARD = "rounded-2xl border border-[#E9EDF4] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const BUTTON = "rounded-xl bg-[#2563EB] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#94A3B8]";
const STAGES: { id: StageKind; entering: string; leaving: string }[] = [
  { id: "exploration", entering: "画像仍有未知维度", leaving: "八个维度都有观察记录" },
  { id: "strengthening", entering: "画像完整，持续训练", leaving: "某维度连续 3 次有效分 ≥75，触发复测" },
  { id: "retest", entering: "画像完整且有待复测维度", leaving: "复测有效分 ≥60 为通过，否则回到强化训练" },
];

export function StageFlow() {
  const { overview, loading, error, refresh } = useStageOverview();
  if (loading && !overview) return <p className={CARD}>正在加载成长阶段…</p>;
  if (error) return <section className={CARD}><p role="alert">{error}</p><button className="mt-3 text-sm font-semibold text-[#1D4ED8] underline" onClick={refresh}>重新加载</button><p className="mt-3"><Link href="/training?mode=daily" className="text-sm text-[#1D4ED8] underline">先做日常训练</Link></p></section>;
  if (!overview) return null;
  return <StageContent overview={overview} refresh={refresh} />;
}

function StageContent({ overview, refresh }: { overview: StageOverview; refresh: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const dimensions = overview.dimensions;
  async function start(item: StageDimension) {
    if (!item.triggerId || busy || !overview.baselineCompleted) return;
    setBusy(item.triggerId); setMessage(null);
    try {
      const result = await startRetest(item.triggerId);
      if (result.state === "ready") {
        const id = encodeURIComponent(result.sessionId);
        router.push(result.awaitingScore ? `/training/feedback/${id}` : `/training/session/${id}`);
      } else {
        setMessage(result.state === "settled" ? "本次复测已结算，正在刷新阶段。" : stageReason(result.reason));
        refresh();
      }
    } catch (reason) {
      if (reason instanceof StageApiError && reason.code === "BASELINE_REQUIRED") router.replace("/baseline");
      else setMessage(reason instanceof Error ? reason.message : "复测暂时无法开始，请稍后重试");
    } finally { setBusy(null); }
  }
  return <div className="mx-auto max-w-6xl">
    <header className="mb-6"><h1 className="text-2xl font-bold">成长阶段与复测</h1><p className="mt-2 text-sm text-[#64748B]">按能力维度持续练习，换题验证进步；每个维度可以独立复测。</p></header>
    <div className="grid gap-4 md:grid-cols-3">
      {STAGES.map((stage) => <section key={stage.id} className={`${CARD} ${overview.stage === stage.id ? "border-[#82B1FF] bg-[#F7FAFF]" : ""}`}>
        <div className="flex justify-between gap-2"><h2 className="font-bold">{stageName(stage.id)}</h2>{overview.stage === stage.id ? <span className="text-xs font-semibold text-[#1D4ED8]">当前阶段</span> : null}</div>
        <p className="mt-4 text-sm text-[#475569]"><b>进入：</b>{stage.entering}</p><p className="mt-2 text-sm text-[#475569]"><b>离开：</b>{stage.leaving}</p>
      </section>)}
    </div>
    {!overview.baselineCompleted ? <div className="mt-5 rounded-xl bg-[#FFF8F1] p-4 text-sm text-[#92400E]">完成基线测评后可开始复测。 <Link href="/baseline" className="font-semibold underline">去完成基线</Link></div> : null}
    {message ? <p role="status" className="mt-4 text-sm text-[#92400E]">{message}</p> : null}
    <div className="mt-5 grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(260px,1fr)]">
      <section className={CARD}><h2 className="text-lg font-bold">维度复测</h2><p className="mt-2 text-sm text-[#64748B]">连续 3 次有效分 ≥75 触发，换题不换维度；复测不占每日训练。</p>
        {dimensions.length ? <div className="mt-4 divide-y divide-[#E9EDF4]">{dimensions.map((item) => <DimensionCard key={item.dimension} item={item} enabled={overview.baselineCompleted} busy={busy !== null} onStart={() => void start(item)} />)}</div> : <p className="mt-4 text-sm text-[#64748B]">持续训练后，在这里查看各维度的复测进度。</p>}
      </section>
      <section className={CARD}><h2 className="text-lg font-bold">成长时间线</h2>{overview.timeline.length ? <ol className="mt-4 space-y-4">{overview.timeline.map((entry) => <li key={entry.id} className="border-l-2 border-[#BFDBFE] pl-3 text-sm text-[#475569]"><p>{timelineText(entry)}</p><time className="text-xs text-[#94A3B8]" dateTime={entry.createdAt}>{entry.createdAt.slice(0, 10)}</time></li>)}</ol> : <p className="mt-4 text-sm text-[#64748B]">复测触发与结果会记录在这里。</p>}</section>
    </div>
  </div>;
}

function DimensionCard({ item, enabled, busy, onStart }: { item: StageDimension; enabled: boolean; busy: boolean; onStart: () => void }) {
  const actionable = item.status === "pending" || item.status === "suspended";
  const waiting = item.activeSessionStatus === "awaiting_score";
  const inconsistentSession = Boolean(item.activeSessionId) !== Boolean(item.activeSessionStatus) || (Boolean(item.activeSessionId) && item.status !== "pending");
  const sessionHref = enabled && item.status === "pending" && !inconsistentSession && item.activeSessionId ? `/training/${waiting ? "feedback" : "session"}/${encodeURIComponent(item.activeSessionId)}` : null;
  return <article className="py-4"><div className="flex flex-wrap items-start justify-between gap-3"><div>
    <h3 className="font-semibold">{item.dimension} · {item.status === "unverified" ? "训练进度" : "换题复测"}</h3>
    <p className="mt-1 text-xs text-[#64748B]">{item.status === "unverified" && !item.observed ? "待探索" : dimensionStatusText(item.status)}{item.consecutive !== null ? ` · 连续达标 ${item.consecutive}/3` : ""}</p>
    {item.reason ? <p className="mt-2 text-sm text-[#92400E]">{stageReason(item.reason)}</p> : null}
    {inconsistentSession ? <p className="mt-2 text-sm text-[#92400E]">会话状态待恢复，请稍后重试。</p> : null}
  </div><div className="flex flex-wrap gap-2">
    {waiting && sessionHref ? <Link href={sessionHref} className="text-sm font-semibold text-[#1D4ED8]">评分中</Link> : sessionHref ? <Link href={sessionHref} className={BUTTON}>继续复测</Link> : actionable && !item.activeSessionId && !item.activeSessionStatus ? <button className={BUTTON} disabled={!enabled || busy || !item.triggerId} onClick={onStart}>{item.status === "suspended" ? `重试${item.dimension}复测` : `开始${item.dimension}复测`}</button> : null}
  </div></div>{item.status === "suspended" || item.status === "needs_recovery" ? <Link href="/training?mode=daily" className="mt-3 inline-block text-sm font-semibold text-[#1D4ED8] underline">先做日常训练</Link> : null}</article>;
}
