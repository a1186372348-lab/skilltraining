"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { fetchStageOverview, StageApiError } from "@/app/stages/api";
import type { StageOverview } from "@/app/stages/contract";

interface StageContextValue {
  overview: StageOverview | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}
const StageContext = createContext<StageContextValue>({ overview: null, loading: true, error: null, refresh: () => {} });

/** 每个页面共用一次只读阶段结果；普通故障不影响其他训练内容。 */
export function StageProvider({ children }: { children: ReactNode }) {
  const { replace } = useRouter();
  const [overview, setOverview] = useState<StageOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true); setError(null);
      void fetchStageOverview().then((value) => {
        if (!cancelled) { setOverview(value); setLoading(false); }
      }).catch((reason: unknown) => {
        if (cancelled) return;
        setOverview(null); setLoading(false);
        if (reason instanceof StageApiError && reason.code === "BASELINE_REQUIRED") {
          if (window.location.pathname !== "/baseline") replace("/baseline");
        } else {
          setError(reason instanceof Error ? reason.message : "阶段状态暂时无法读取");
        }
      });
    }, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [version, replace]);
  return <StageContext.Provider value={{ overview, loading, error, refresh }}>{children}</StageContext.Provider>;
}

export function useStageOverview(): StageContextValue { return useContext(StageContext); }
