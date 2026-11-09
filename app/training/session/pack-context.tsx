"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { abandonPackSession, fetchPack } from "../pack/api";
import type { PackDetail } from "../pack/contract";

/** 包题工作台显示来源与真实进度，并明确确认终止整包。 */
export function PackContext({ packId, sessionId, canAbandon }: { packId: string; sessionId: string; canAbandon: boolean }) {
  const router = useRouter();
  const [pack, setPack] = useState<PackDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchPack(packId).then((value) => { if (!cancelled) setPack(value); })
        .catch(() => { if (!cancelled) setFailed(true); });
    }, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [packId]);

  async function confirm() {
    if (pending || !canAbandon) return;
    setPending(true); setError(null);
    try { await abandonPackSession(sessionId); router.push("/training"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "终止失败，请稍后重试"); }
    finally { setPending(false); }
  }

  const current = pack?.items.find((item) => item.sessionId === sessionId);
  const done = pack?.items.filter((item) => item.state === "scored").length ?? 0;
  const title = current && pack ? `专项训练包 · ${pack.dimension} · 第 ${current.orderIndex + 1}/5 题 · 已完成 ${done}/5` :
    failed || pack ? "专项训练包 · 进度暂不可用" : "专项训练包 · 正在加载进度";
  return (
    <section className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-[#D9E7FD] bg-[#F7FAFF] px-4 py-3 text-sm xl:shrink-0">
      <span className="font-semibold text-[#1D4ED8]">{title}</span>
      <Link href={`/training/pack/${encodeURIComponent(packId)}`} className="text-xs font-semibold text-[#1D4ED8] underline">查看训练包</Link>
      {canAbandon && !confirming ? <button type="button" onClick={() => setConfirming(true)} className="ml-auto text-xs font-semibold text-[#B45309]">终止本题</button> : null}
      {canAbandon && confirming ? <div className="flex flex-wrap items-center gap-3 text-xs text-[#92400E]">
        <span>终止本题会放弃整个训练包，已答内容与评分保留。</span>
        <button type="button" disabled={pending} onClick={() => void confirm()} className="font-bold">确认终止</button>
        <button type="button" disabled={pending} onClick={() => { setConfirming(false); setError(null); }}>取消</button>
      </div> : null}
      {error ? <span role="alert" className="text-xs text-[#B45309]">{error}</span> : null}
    </section>
  );
}
