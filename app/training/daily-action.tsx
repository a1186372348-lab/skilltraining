"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchTodaySession } from "./session/api";

/** 独立日常入口跳过复测推荐，服务端仍负责包、计划与会话约束。 */
export function DailyTrainingAction() {
  const { push, replace } = useRouter();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = useCallback(async (fromLink = false) => {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true); setError(null);
    try {
      const today = await fetchTodaySession("daily");
      if (!today) throw new Error("今日暂无可用训练，请稍后重试。");
      const navigate = fromLink ? replace : push;
      if ((today as typeof today & { kind?: string }).kind === "baseline") navigate("/baseline");
      else navigate(`/training/session/${encodeURIComponent(today.sessionId)}`);
    } catch (reason) {
      if (reason instanceof ApiError && (reason.code === "BASELINE_REQUIRED" || reason.code === "BASELINE_SCORING_PENDING")) (fromLink ? replace : push)("/baseline");
      else setError(reason instanceof Error ? reason.message : "日常训练暂不可用，请稍后重试。");
    } finally { inFlight.current = false; setPending(false); }
  }, [push, replace]);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("mode") !== "daily") return;
    const timer = setTimeout(() => void start(true), 0);
    return () => clearTimeout(timer);
  }, [start]);
  return <div className="mb-5 flex flex-wrap items-center gap-3">
    <button type="button" disabled={pending} onClick={() => void start()} className="text-sm font-semibold text-[#1D4ED8] underline disabled:opacity-60">{pending ? "正在进入日常训练…" : "先做日常训练"}</button>
    {error ? <span role="alert" className="text-sm text-[#B45309]">{error}</span> : null}
  </div>;
}
