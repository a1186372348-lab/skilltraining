"use client";

import Link from "next/link";
import { useStageOverview } from "./stage-provider";
import { stageName } from "@/app/stages/view-model";

/** 宽窄屏共用同一 Provider，不在失败时阻塞原页面。 */
export function StageBadge({ compact = false }: { compact?: boolean }) {
  const { overview } = useStageOverview();
  if (!overview) return null;
  const pending = overview.dimensions.filter((item) => item.status === "pending" || item.status === "suspended" || item.status === "needs_recovery").length;
  return <Link href="/stages" className={compact ? "mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-[#D9E7FD] bg-white px-3 py-2 text-xs text-[#334155]" : "mt-5 block rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-xs text-[#C4CDDD]"}>
    <span>成长阶段 · </span><strong className={compact ? "text-[#1D4ED8]" : "text-white"}>{stageName(overview.stage)}</strong>
    <span className={compact ? "ml-auto text-[#64748B]" : "mt-2 block text-[#8B98B2]"}>{!overview.baselineCompleted ? "先完成基线测评" : pending ? `${pending} 个维度待复测` : "查看成长进度 →"}</span>
  </Link>;
}
