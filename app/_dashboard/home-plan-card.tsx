"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchCurrentPlan } from "@/app/_shared/plan-api";
import type { PlanProgressView, TrainingPlanView } from "@/app/_shared/plan-view-model";

export function HomePlanCard() {
  const [data, setData] = useState<{ plan: TrainingPlanView | null; progress: PlanProgressView | null } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => { void fetchCurrentPlan().then((value) => { if (!cancelled) setData(value); }).catch(() => { if (!cancelled) setFailed(true); }); }, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);
  return <section className="rounded-xl border border-[#D9E7FD] bg-[#F7FAFF] p-4">
    <h3 className="text-sm font-bold text-[#1D4ED8]">本周计划</h3>
    {failed ? <p className="mt-2 text-sm text-[#64748B]">计划暂不可用，可在产品训练中重试。</p> : !data ? <p className="mt-2 text-sm text-[#64748B]">正在加载计划…</p> : data.plan ? <>
      <p className="mt-2 text-sm font-semibold">主攻「{data.plan.focusDimension}」 · {data.plan.status === "active" ? "进行中" : data.plan.status === "rejected" ? "已拒绝" : "已归档"}</p>
      <p className="mt-2 text-xs leading-5 text-[#64748B]">{data.plan.reason}</p>
      {data.progress ? <p className="mt-2 text-xs text-[#64748B]">本周已完成 {data.progress.completedDays} 天 · 已评分 {data.progress.scoredCount} 题</p> : null}
    </> : <p className="mt-2 text-sm text-[#64748B]">暂无本周计划，继续训练后可查看主攻方向。</p>}
    <Link href="/training" className="mt-3 inline-block text-xs font-semibold text-[#1D4ED8] underline">管理计划与周回顾 →</Link>
  </section>;
}
