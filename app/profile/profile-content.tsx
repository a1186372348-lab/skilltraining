"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { createTrainingPack } from "./api";
import type { AbilityDimensionView, AbilityPageView } from "./contract";
import { NodeDetailModal } from "./node-detail-modal";
import {
  diagnosisLineOf, featureLineOf, formatProfileScore, gaugeLevelOf, isGuideState,
  observationText, sparklineGeometry, sparklineStroke, statusTagClass, weakestObservedDimension,
} from "./view-model";

const CARD = "rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";

/** 八维行内画像及专项训练包入口。 */
export function ProfileContent({ view }: { view: AbilityPageView }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<string | null>(() => weakestObservedDimension(view.dimensions)?.dimension ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ dimension: string; message: string } | null>(null);
  const selectedDim = view.dimensions.find((dim) => dim.dimension === selected) ?? null;

  async function startPack(dimension: string) {
    if (pending) return;
    setPending(dimension);
    setActionError(null);
    try {
      const id = await createTrainingPack(dimension);
      router.push(`/training/pack/${encodeURIComponent(id)}`);
    } catch (error) {
      setActionError({ dimension, message: error instanceof Error ? error.message : "发起失败，请稍后重试" });
    } finally { setPending(null); }
  }

  return (
    <div className="flex flex-col gap-5 pb-4">
      <div className="rounded-xl border border-[#D9E7FD] border-l-[3px] border-l-[#2563EB] bg-[#F7FAFF] px-5 py-3.5 text-sm text-[#33425E]">
        AI 已了解你 <b className="text-[#1D4ED8]">{view.insight.observedCount}/{view.insight.totalCount}</b> 个维度 · {view.insight.nextFocus.text}
      </div>
      {isGuideState(view) ? <GuideCard /> : null}
      <section className={`${CARD} overflow-hidden`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E9EDF4] px-6 py-4">
          <h2 className="text-[15px] font-bold">能力维度</h2>
          <span className="text-xs text-[#94A3B8]">共 {view.dimensions.length} 个维度 · 一次只进行一个训练包</span>
        </div>
        <ul>
          {view.dimensions.map((dim) => (
            <DimensionRow key={dim.dimension} dim={dim} expanded={expanded === dim.dimension}
              isNextFocus={view.insight.nextFocus.mode === "strengthen" && view.insight.nextFocus.dimension === dim.dimension}
              pending={pending !== null} error={actionError?.dimension === dim.dimension ? actionError.message : null}
              onToggle={() => setExpanded((prev) => prev === dim.dimension ? null : dim.dimension)}
              onDetails={() => setSelected(dim.dimension)} onStart={() => void startPack(dim.dimension)} />
          ))}
        </ul>
      </section>
      {!isGuideState(view) ? <HintDependencyGauge view={view} /> : null}
      {selectedDim ? <NodeDetailModal dim={selectedDim} nextFocus={view.insight.nextFocus} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function DimensionRow({ dim, expanded, isNextFocus, pending, error, onToggle, onDetails, onStart }: {
  dim: AbilityDimensionView; expanded: boolean; isNextFocus: boolean; pending: boolean; error: string | null;
  onToggle: () => void; onDetails: () => void; onStart: () => void;
}) {
  const spark = sparklineGeometry(dim.sparkline);
  return (
    <li className="border-b border-[#F0F3F8] px-6 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <button type="button" onClick={onToggle} aria-expanded={expanded} disabled={!dim.observed}
          className="flex min-w-[220px] flex-1 flex-wrap items-center gap-4 text-left disabled:cursor-default">
          <span className="w-28 text-sm font-semibold text-[#1E293B]">{dim.dimension}</span>
          {dim.observed && dim.currentScore !== null ? <span className="text-[23px] font-bold text-[#0F172A]">{formatProfileScore(dim.currentScore)}</span> : <span className="text-xs text-[#94A3B8]">未观测</span>}
          <span className="text-xs text-[#64748B]">{observationText(dim.observationCount)}</span>
          {spark ? <svg viewBox="0 0 120 32" width={96} height={26} fill="none" aria-hidden className="hidden sm:block"><polyline points={spark.points} stroke={sparklineStroke(dim.trend)} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" /><circle cx={spark.end.x} cy={spark.end.y} r={2.4} fill={sparklineStroke(dim.trend)} /></svg> : null}
          {dim.statusLabel ? <span className={`rounded-full border px-2 py-1 text-[11px] font-semibold ${statusTagClass(dim.statusLabel)}`}>{dim.statusLabel}</span> : null}
        </button>
        {dim.observed ? <button type="button" onClick={onDetails} className="text-xs font-semibold text-[#1D4ED8] hover:underline">查看评估记录</button> : null}
        <PackAction dim={dim} pending={pending} onStart={onStart} />
      </div>
      {error ? <p role="alert" className="mt-2 text-xs text-[#B45309]">{error}</p> : null}
      {expanded && dim.observed ? (
        <div className="mt-3 rounded-r-xl border-l-[3px] border-l-[#2563EB] bg-[#F7FAFF] px-5 py-3 text-xs leading-6 text-[#475569]">
          <p><b>特征</b>：{featureLineOf(dim)}</p>
          <p><b>诊断</b>：{diagnosisLineOf(dim)} {isNextFocus ? <span className="font-semibold text-[#1D4ED8]">建议重点练</span> : null}</p>
        </div>
      ) : null}
    </li>
  );
}

function PackAction({ dim, pending, onStart }: { dim: AbilityDimensionView; pending: boolean; onStart: () => void }) {
  const cta = dim.packCta;
  if (cta?.status === "active-self" && cta.activePackId) {
    const progress = cta.completedCount === null ? "" : ` · ${cta.completedCount}/5`;
    return <Link href={`/training/pack/${encodeURIComponent(cta.activePackId)}`} className="rounded-lg bg-[#2563EB] px-3 py-2 text-xs font-semibold text-white">继续攻坚包{progress}</Link>;
  }
  const reason = !cta ? "训练包状态暂不可用，请稍后重试" :
    cta.status === "baseline-required" ? "请先完成基线测评再发起训练包" :
    cta.status === "disabled-other-active" ? "一次只能进行一个训练包，请先完成或放弃当前包" :
    cta.status === "disabled-insufficient" ? `可用未练题 ${cta.availableQuestions}/${cta.requiredQuestions}，暂不能发起` :
    cta.status === "active-self" ? "当前训练包信息暂不可用" : null;
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <button type="button" disabled={pending || !!reason} onClick={onStart}
        className="rounded-lg border border-[#BFDBFE] px-3 py-2 text-xs font-semibold text-[#1D4ED8] disabled:cursor-not-allowed disabled:border-[#E2E8F0] disabled:text-[#94A3B8]">发起攻坚包</button>
      {reason ? <span className="max-w-[220px] text-xs leading-5 text-[#64748B]">{reason}</span> : null}
    </div>
  );
}

function HintDependencyGauge({ view }: { view: AbilityPageView }) {
  const overall = view.hintDependencyOverall;
  const level = gaugeLevelOf(overall?.band ?? null);
  const colors = ["#BFDBFE", "#93C5FD", "#60A5FA", "#3B82F6", "#2563EB"];
  return (
    <section className={`${CARD} flex flex-wrap items-center gap-x-8 gap-y-4 px-7 py-5`}>
      <div><h3 className="mb-1 text-[15px] font-bold">整体提示依赖度</h3><p className="text-xs text-[#94A3B8]">提示使用越独立，得分系数越高</p></div>
      <div className="flex gap-1.5 sm:ml-auto">{colors.map((color, index) => <span key={color} className="h-[9px] w-[36px] rounded-[5px]" style={{ backgroundColor: index < level ? color : "#E2E8F0" }} />)}</div>
      <span className="rounded-xl border border-[#D9E7FD] bg-[#EFF5FF] px-5 py-2.5 font-bold text-[#1D4ED8]">{overall ? overall.band : "—"}</span>
    </section>
  );
}

function GuideCard() {
  return (
    <section className={`${CARD} p-10 text-center`}>
      <h2 className="text-lg font-bold">开始第一次训练后，生成你的能力画像</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#475569]">AI 会基于你的每次作答逐步观测 8 个能力维度；未知维度不会被当作 0 分。</p>
      <Link href="/training" className="mt-6 inline-flex rounded-xl bg-[#2563EB] px-5 py-2.5 text-sm font-bold text-white">去今日训练 ▸</Link>
    </section>
  );
}
