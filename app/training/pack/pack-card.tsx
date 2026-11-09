"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchActivePack } from "./api";
import type { PackDetail } from "./contract";

/** 大厅独立加载包卡，失败不阻断当前训练和历史。 */
export function PackCard({ refreshToken = 0 }: { refreshToken?: number }) {
  const [pack, setPack] = useState<PackDetail | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchActivePack().then((result) => { if (!cancelled) { setPack(result); setError(false); } })
        .catch(() => { if (!cancelled) { setPack(null); setError(true); } });
    }, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [retry, refreshToken]);

  useEffect(() => {
    if (!pack || pack.status !== "active" || !pack.items.some((item) => item.state === "awaiting_score")) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void fetchActivePack().then((result) => { if (!cancelled) setPack(result); })
        .catch(() => { if (!cancelled) { setPack(null); setError(true); } });
    }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [pack]);

  if (error) return <div className="mb-6 rounded-xl border border-[#E9EDF4] bg-white px-5 py-3 text-sm text-[#64748B]">训练包状态暂不可用 <button type="button" onClick={() => setRetry((value) => value + 1)} className="ml-2 font-semibold text-[#1D4ED8] underline">重试</button></div>;
  if (!pack) return null;
  const done = pack.items.filter((item) => item.state === "scored").length;
  const waiting = pack.items.some((item) => item.state === "awaiting_score");
  const inconsistent = pack.items.some((item) => item.state === "inconsistent");
  return (
    <section className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#D9E7FD] bg-[#F7FAFF] p-5">
      <div><h2 className="text-base font-bold">{pack.dimension} · 专项训练包</h2><p className="mt-1 text-xs text-[#64748B]">已完成 {done}/5{inconsistent ? " · 状态待恢复" : waiting ? " · 评分中" : " · 按顺序解锁"}</p></div>
      <Link href={`/training/pack/${encodeURIComponent(pack.id)}`} className="rounded-xl bg-[#2563EB] px-4 py-2 text-sm font-semibold text-white">继续攻坚 →</Link>
    </section>
  );
}
