"use client";

import Link from "next/link";
import { useStageOverview } from "@/app/_shared/stage-badge/stage-provider";
import type { StageOverview } from "@/app/stages/contract";
import { dimensionStatusText, stageName } from "@/app/stages/view-model";
import { HomePackCard } from "./home-pack-card";
import { HomePlanCard } from "./home-plan-card";

type NodeState = "已完成" | "当前" | "待开启" | "待复测";
interface CampaignNode { title: string; description: string; state: NodeState }

function nodesFor(data: StageOverview): CampaignNode[] {
  const started = data.baselineCompleted;
  const pending = data.dimensions.filter((item) => item.status === "pending" || item.status === "suspended" || item.status === "needs_recovery");
  return [
    { title: "起点 · 基线测评", description: "完成基线测评，建立能力画像。", state: started ? "已完成" : "当前" },
    { title: "探索期", description: "画像有未知维度时，优先探索盲区。", state: !started ? "待开启" : data.stage === "exploration" ? "当前" : "已完成" },
    { title: "强化期", description: "画像完整后，围绕薄弱维度持续练习。", state: !started || data.stage === "exploration" ? "待开启" : data.stage === "strengthening" ? "当前" : "已完成" },
    { title: "复测期", description: "任一维度连续 3 次有效分 ≥75 后，换题复测。", state: !started ? "待开启" : data.stage === "retest" ? "当前" : pending.length ? "待复测" : "待开启" },
  ];
}

export function CampaignMap() {
  const { overview, loading, error, refresh } = useStageOverview();
  const pending = overview?.dimensions.filter((item) => item.status === "pending" || item.status === "suspended" || item.status === "needs_recovery") ?? [];
  return <section aria-labelledby="campaign-title" className="mb-7">
    <div className="rounded-t-2xl bg-gradient-to-r from-[#172C52] to-[#284E86] p-5 text-white sm:p-6">
      <h2 id="campaign-title" className="text-lg font-bold">你的成长战役地图</h2>
      <p className="mt-2 text-sm text-[#D6E4FA]">{overview ? overview.baselineCompleted ? `当前${stageName(overview.stage)}，每个维度都可以独立成长。` : "完成基线测评，从起点出发。" : "成长进度会随训练和复测更新。"}</p>
    </div>
    <div className="rounded-b-2xl border border-[#E9EDF4] bg-white p-5 sm:p-6">
      {loading && !overview ? <p className="text-sm text-[#64748B]">正在加载成长进度…</p> : null}
      {error ? <div className="flex flex-wrap items-center gap-3 text-sm text-[#B45309]"><span>{error}</span><button onClick={refresh} className="font-semibold underline">重试阶段状态</button></div> : null}
      {overview ? <>
        <ol className="relative grid gap-5 md:grid-cols-4 md:before:absolute md:before:top-8 md:before:right-[12%] md:before:left-[12%] md:before:h-1 md:before:rounded-full md:before:bg-[#E2E8F0]">
          {nodesFor(overview).map((node, index) => <li key={node.title} className="relative z-10 flex items-start gap-4 md:flex-col md:items-center md:text-center">
            <span aria-hidden className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full border-4 border-white text-xl font-bold ${node.state === "当前" ? "bg-[#2563EB] text-white shadow-[0_0_0_6px_rgba(37,99,235,0.14)]" : node.state === "已完成" ? "bg-[#60A5FA] text-white" : "bg-[#EDF1F7] text-[#94A3B8]"}`}>{node.state === "已完成" ? "✓" : index + 1}</span>
            <div><h3 className="text-sm font-bold">{node.title}</h3><p className="mt-2 text-xs leading-5 text-[#64748B]">{node.description}</p><span className="mt-2 inline-block rounded-full bg-[#EFF5FF] px-3 py-1 text-xs font-semibold text-[#1D4ED8]">{node.state}</span></div>
          </li>)}
        </ol>
        {!overview.baselineCompleted ? <Link href="/baseline" className="mt-4 inline-block text-sm font-semibold text-[#1D4ED8] underline">完成基线测评</Link> : null}
        {overview.baselineCompleted && pending.length ? <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-[#FFF8F1] p-3 text-sm text-[#92400E]"><span>{pending.map((item) => `${item.dimension}（${dimensionStatusText(item.status)}）`).join("、")}</span><Link href="/stages" className="font-semibold underline">查看复测 →</Link></div> : null}
      </> : null}
      <div className="relative mt-8 border-t border-[#E9EDF4] pt-5 before:absolute before:-top-4 before:left-1/2 before:h-4 before:w-px before:bg-[#C9D6EA]"><p className="mb-3 text-xs font-semibold text-[#64748B]">当前阶段的计划与专项训练</p><div className="grid items-stretch gap-4 lg:grid-cols-2"><HomePlanCard /><HomePackCard /></div></div>
    </div>
  </section>;
}
