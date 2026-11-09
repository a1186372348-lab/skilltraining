"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { displayCaseTitle } from "@/app/_shared/question-display";

import { fetchHistoryDetail } from "../../history/api";
import type { HistoryDetailView } from "../../history/contract";
import { TodayShell } from "../../session/shell";
import { abandonPack, fetchPack, PackApiError, startPackItem } from "../api";
import type { PackDetail, PackItem, PackTier } from "../contract";

const CARD = "rounded-2xl border border-[#E9EDF4] bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const BUTTON = "rounded-xl bg-[#2563EB] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1D4ED8] disabled:cursor-not-allowed disabled:bg-[#94A3B8]";
const TIERS: Record<PackTier, string> = { basic: "基础", advanced: "进阶", challenge: "挑战" };

/** 本人训练包：评分完成后由服务端权威状态解锁下一题。 */
export function PackFlow({ packId }: { packId: string }) {
  return <PackContent key={packId} packId={packId} />;
}

function PackContent({ packId }: { packId: string }) {
  const router = useRouter();
  const mounted = useRef(false);
  const [pack, setPack] = useState<PackDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchPack(packId).then((value) => {
        if (!cancelled) { setPack(value); setLoading(false); }
      }).catch((reason: unknown) => {
        if (cancelled) return;
        if (reason instanceof PackApiError && reason.code === "BASELINE_REQUIRED") { router.replace("/baseline"); return; }
        setError(reason instanceof Error ? reason.message : "训练包暂时无法加载");
        setLoading(false);
      });
    }, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [packId, retry, router]);

  useEffect(() => {
    if (!pack || pack.id !== packId || pack.status !== "active" || !pack.items.some((item) => item.state === "awaiting_score")) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void fetchPack(packId).then((value) => { if (!cancelled) setPack(value); }).catch(() => {
        if (!cancelled) setError("刷新评分状态失败，请稍后重试");
      });
    }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [pack, packId]);

  const start = useCallback(async (index: number) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await startPackItem(packId, index);
      if (!mounted.current) return;
      if (result.state === "in_progress") {
        router.push(`/training/session/${encodeURIComponent(result.sessionId)}`);
      } else {
        // 并发回读可能已在评分或完成；以服务端最新状态刷新，不伪装成可作答。
        const refreshed = await fetchPack(packId);
        if (mounted.current) setPack(refreshed);
      }
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "开始训练失败，请稍后重试"); }
    finally { if (mounted.current) setBusy(false); }
  }, [busy, packId, router]);

  const abandon = useCallback(async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const abandoned = await abandonPack(packId);
      if (mounted.current) { setPack(abandoned); setConfirming(false); }
    }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "放弃训练包失败，请稍后重试"); }
    finally { if (mounted.current) setBusy(false); }
  }, [busy, packId]);

  // 路由参数变化时立即隐藏前一个包，避免短暂展示错误会话的答案或成绩。
  const currentPack = pack?.id === packId ? pack : null;
  const done = currentPack?.items.filter((item) => item.state === "scored").length ?? 0;
  return (
    <TodayShell stageText={currentPack?.status === "active" ? `专项包 ${done}/5` : "训练包"}>
      <div className="mx-auto max-w-6xl">
        <Link href="/training" className="text-sm font-semibold text-[#1D4ED8] hover:underline">← 产品训练</Link>
        <h1 className="mt-4 text-2xl font-bold">专项训练包</h1>
        <p className="mt-2 text-sm text-[#64748B]">按能力维度逐题练习，一次只进行一个训练包</p>
        {loading || (!currentPack && !error) ? <p className={`${CARD} mt-6 text-sm text-[#64748B]`}>正在加载训练包…</p> : null}
        {error ? <div role="alert" className="mt-4 text-sm text-[#B45309]">{error} {!currentPack ? <button type="button" onClick={() => { setError(null); setLoading(true); setRetry((n) => n + 1); }} className="ml-2 font-semibold underline">重新加载</button> : null}</div> : null}
        {currentPack ? (
          <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(300px,1fr)]">
            <section className={CARD}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><h2 className="text-lg font-bold">{currentPack.dimension} · 专项训练包</h2><p className="mt-1 text-xs text-[#64748B]">基础 2 题 → 进阶 2 题 → 挑战 1 题</p></div>
                <span className="rounded-full bg-[#EFF5FF] px-3 py-1 text-xs font-semibold text-[#1D4ED8]">{currentPack.status === "abandoned" ? "已放弃" : currentPack.status === "completed" ? "已完成" : `已完成 ${done}/5`}</span>
              </div>
              <p className="mt-4 text-xs leading-6 text-[#64748B]">上一题评分完成后解锁下一题；递补题会标明实际难度。</p>
              <ol className="mt-4 divide-y divide-[#E9EDF4]">
                {[...currentPack.items].sort((a, b) => a.orderIndex - b.orderIndex).map((item) => <ItemRow key={`${item.questionId}:${item.sessionId ?? "new"}`} item={item} active={currentPack.status === "active"} busy={busy} onStart={() => void start(item.orderIndex)} />)}
              </ol>
              {currentPack.status === "active" ? <div className="mt-5">
                {!confirming ? <button type="button" onClick={() => setConfirming(true)} className="text-sm font-semibold text-[#B45309] hover:underline">放弃训练包</button> : (
                  <div className="flex flex-wrap items-center gap-3 rounded-xl bg-[#FFF8F1] p-3 text-sm text-[#92400E]">
                    <span>放弃后不再继续本包，已答内容与评分保留。</span>
                    <button type="button" disabled={busy} onClick={() => void abandon()} className={BUTTON}>确认放弃</button>
                    <button type="button" disabled={busy} onClick={() => setConfirming(false)} className="text-sm font-semibold">取消</button>
                  </div>
                )}
              </div> : null}
            </section>
            <div className="flex flex-col gap-5"><Diagnosis pack={currentPack} /><Rules /></div>
          </div>
        ) : null}
      </div>
    </TodayShell>
  );
}

function ItemRow({ item, active, busy, onStart }: { item: PackItem; active: boolean; busy: boolean; onStart: () => void }) {
  const number = item.orderIndex + 1;
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#EFF5FF] text-sm font-bold text-[#1D4ED8]">{number}</span>
        <div className="min-w-[180px] flex-1"><h3 className="text-sm font-semibold">{displayCaseTitle(item.caseTitle)}</h3>
          <p className="mt-1 text-xs text-[#64748B]">目标{TIERS[item.targetTier]} · 实际{TIERS[item.actualTier]}（难度 {item.actualDifficulty}/5）{item.substituted ? " · 递补" : ""}</p>
        </div>
        {item.state === "scored" && item.effectiveScore !== null ? <b className="text-sm text-[#1D4ED8]">{item.effectiveScore} 分</b> : null}
        {active && item.state === "available" ? <button type="button" disabled={busy} onClick={onStart} className={BUTTON}>开始第 {number} 题</button> : null}
        {active && item.state === "in_progress" && item.sessionId ? <Link href={`/training/session/${encodeURIComponent(item.sessionId)}`} className={BUTTON}>继续作答</Link> : null}
        {item.state === "awaiting_score" ? <span className="text-xs font-semibold text-[#1D4ED8]">评分中</span> : null}
        {item.state === "locked" ? <span className="text-xs text-[#94A3B8]">待解锁</span> : null}
        {item.state === "inconsistent" || (item.state === "in_progress" && !item.sessionId) ? <span className="text-xs text-[#B45309]">训练状态待恢复</span> : null}
        {item.state === "unavailable" ? <span className="text-xs text-[#B45309]">题目暂不可用</span> : null}
      </div>
      {item.state === "scored" && item.sessionId ? <>
        <ScoredSummary sessionId={item.sessionId} number={number} />
        <Link href={`/training/feedback/${encodeURIComponent(item.sessionId)}`} className="ml-11 mt-2 inline-block text-xs font-semibold text-[#1D4ED8] hover:underline">查看第 {number} 题完整反馈</Link>
      </> : null}
    </li>
  );
}

function textSummary(value: string | null | undefined): string {
  if (!value) return "暂无记录";
  const chars = Array.from(value);
  return chars.length > 200 ? `${chars.slice(0, 200).join("")}…` : value;
}

function ScoredSummary({ sessionId, number }: { sessionId: string; number: number }) {
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState<HistoryDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function toggle() {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (history || loading) return;
    setLoading(true); setError(null);
    try { setHistory(await fetchHistoryDetail(sessionId)); }
    catch { setError("评估详情暂不可用，请收起后重试"); }
    finally { setLoading(false); }
  }
  return (
    <div className="ml-11 mt-2">
      <button type="button" onClick={() => void toggle()} aria-expanded={expanded} className="text-xs font-semibold text-[#1D4ED8] hover:underline">{expanded ? `收起第 ${number} 题摘要` : `查看第 ${number} 题摘要`}</button>
      {expanded && loading ? <p className="mt-2 text-xs text-[#64748B]">加载中…</p> : null}
      {expanded && error ? <p role="alert" className="mt-2 text-xs text-[#B45309]">{error}</p> : null}
      {expanded && history ? <div className="mt-2 rounded-xl bg-[#F8FAFC] p-3 text-xs leading-6 text-[#475569]">
        <p><b>首次作答</b>：{textSummary(history.firstAnswer)}</p>
        <p><b>最终作答</b>：{textSummary(history.finalAnswer)}</p>
        <p><b>AI 点评</b>：{textSummary(history.feedback?.topIssueText)}</p>
        <p><b>下一步</b>：{textSummary(history.feedback?.nextFocusText)}</p>
      </div> : null}
    </div>
  );
}

function Diagnosis({ pack }: { pack: PackDetail }) {
  return (
    <section className={CARD}>
      <h2 className="text-base font-bold">包级诊断</h2>
      <p className="mt-1 text-xs text-[#64748B]">有效分轨迹</p>
      <div className="mt-4 grid grid-cols-5 gap-2">
        {pack.diagnosis.trajectory.map((point) => <div key={point.orderIndex} className="text-center"><span className="text-sm font-bold text-[#1D4ED8]">{point.effectiveScore ?? "—"}</span><div className="mx-auto mt-2 h-20 w-5 rounded-md bg-[#EEF2F7] flex items-end"><span className="w-full rounded-md bg-[#60A5FA]" style={{ height: `${point.effectiveScore ?? 0}%` }} /></div><span className="mt-1 block text-xs text-[#94A3B8]">第 {point.orderIndex + 1} 题</span></div>)}
      </div>
      <p className="mt-5 border-t border-[#E9EDF4] pt-4 text-sm leading-6 text-[#475569]"><b>下一阶段建议</b>：{pack.diagnosis.advice ?? "完成全部五题评分后生成具体建议。"}</p>
    </section>
  );
}

function Rules() {
  return <section className={CARD}><h2 className="text-base font-bold">训练包规则</h2><p className="mt-3 text-sm leading-7 text-[#64748B]">同维度 5 题，基础 2 → 进阶 2 → 挑战 1；评分完成后解锁下一题。包内成绩照常计入能力画像，符合条件的包题也计入关联周计划。</p></section>;
}
