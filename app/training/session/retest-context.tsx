"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { abandonSession } from "./api";

/** 未终答复测可终止当前题，但触发仍在，后续由服务端换题或挂起。 */
export function RetestContext({ sessionId, canAbandon }: { sessionId: string; canAbandon: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    if (pending || !canAbandon) return;
    setPending(true); setError(null);
    try { await abandonSession(sessionId); router.push("/stages"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "终止暂不可用，请稍后重试"); }
    finally { setPending(false); }
  }
  return <section className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-[#D9E7FD] bg-[#F7FAFF] px-4 py-3 text-sm xl:shrink-0">
    <span className="font-semibold text-[#1D4ED8]">复测验证 · 使用未练题检验该能力，不占每日训练</span>
    <Link href="/stages" className="text-xs font-semibold text-[#1D4ED8] underline">查看复测进度</Link>
    {canAbandon && !confirming ? <button type="button" onClick={() => setConfirming(true)} className="ml-auto text-xs font-semibold text-[#B45309]">终止本题</button> : null}
    {canAbandon && confirming ? <div className="flex flex-wrap items-center gap-3 text-xs text-[#92400E]">
      <span>已答内容与复测触发保留；可换题继续，无题时暂时挂起。</span>
      <button type="button" disabled={pending} onClick={() => void confirm()} className="font-bold">确认终止</button>
      <button type="button" disabled={pending} onClick={() => { setConfirming(false); setError(null); }}>取消</button>
    </div> : null}
    {error ? <span role="alert" className="text-xs text-[#B45309]">{error}</span> : null}
  </section>;
}
