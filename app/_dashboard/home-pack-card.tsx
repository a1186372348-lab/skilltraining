"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchTrainingHub } from "@/app/training/api";
import { fetchActivePack, fetchPack } from "@/app/training/pack/api";
import type { PackDetail } from "@/app/training/pack/contract";
import { historyPackHrefFor } from "@/app/training/view-model";

export function HomePackCard() {
  const [pack, setPack] = useState<PackDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => { void (async () => {
      try {
        let value = await fetchActivePack();
        if (!value) {
          const history = await fetchTrainingHub();
          const recent = history.history.find((item) => historyPackHrefFor(item));
          if (recent?.sourceId) value = await fetchPack(recent.sourceId);
        }
        if (!cancelled) { setPack(value); setFailed(false); setLoading(false); }
      } catch { if (!cancelled) { setPack(null); setFailed(true); setLoading(false); } }
    })(); }, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [version]);
  useEffect(() => {
    if (!pack || pack.status !== "active" || !pack.items.some((item) => item.state === "awaiting_score")) return;
    const timer = setTimeout(() => setVersion((value) => value + 1), 3000);
    return () => clearTimeout(timer);
  }, [pack]);
  const done = pack?.items.filter((item) => item.state === "scored").length ?? 0;
  const waiting = pack?.items.some((item) => item.state === "awaiting_score");
  const inconsistent = pack?.items.some((item) => item.state === "inconsistent");
  return <section className="rounded-xl border border-[#E5EAF2] bg-[#FAFBFD] p-4"><h3 className="text-sm font-bold text-[#334155]">专项训练包</h3>
    {loading ? <p className="mt-2 text-sm text-[#64748B]">正在加载训练包…</p> : failed ? <p className="mt-2 text-sm text-[#64748B]">训练包状态暂不可用。 <button onClick={() => setVersion((value) => value + 1)} className="font-semibold text-[#1D4ED8] underline">重试</button></p> : pack ? <>
      <p className="mt-2 text-sm font-semibold">{pack.dimension} · {pack.status === "completed" ? "训练包已完成" : pack.status === "abandoned" ? "训练包已放弃" : "专项训练包"}</p>
      <p className="mt-2 text-xs text-[#64748B]">已完成 {done}/5{inconsistent ? " · 状态待恢复" : waiting ? " · 评分中" : ""}</p>
      <Link href={`/training/pack/${encodeURIComponent(pack.id)}`} className="mt-3 inline-block text-xs font-semibold text-[#1D4ED8] underline">{pack.status === "completed" ? "查看包诊断" : "查看训练包"} →</Link>
    </> : <><p className="mt-2 text-sm text-[#64748B]">暂无训练包，可从能力画像选择维度。</p><Link href="/profile" className="mt-3 inline-block text-xs font-semibold text-[#1D4ED8] underline">查看能力画像 →</Link></>}
  </section>;
}
