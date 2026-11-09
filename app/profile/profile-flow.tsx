"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { fetchAbilityProfile, ProfileApiError } from "./api";
import type { AbilityPageView } from "./contract";
import { ProfileContent } from "./profile-content";
import { ProfileShell } from "./shell";

/**
 * 能力画像页交互主体（P2，T09：US-008 / FR-8 / BR-6）。
 * 数据流：进入即 GET /api/profile/ability → 顶部洞察条（n/8 + 下一题优先方向）
 * → 八维行内列表（分数、观察、趋势、评估记录和训练包入口）；未知维度不显示 0 分。
 * 8 维全部未观测时保留开始训练的引导。
 */

const CARD =
  "rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const PRIMARY_BTN =
  "inline-flex items-center gap-2 rounded-xl bg-[#2563EB] px-6 py-3 text-sm font-bold text-white shadow-[0_4px_12px_rgba(37,99,235,0.25)] transition-colors hover:bg-[#1D4ED8]";

type Phase = "loading" | "ready" | "error";

export function ProfileFlow() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [view, setView] = useState<AbilityPageView | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** 手动重试令牌：递增触发 effect 重新拉取 */
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // 延迟到 effect 同步阶段之后执行，避免同步 setState 引发级联渲染
    const timer = setTimeout(() => {
      fetchAbilityProfile()
        .then((data) => {
          if (cancelled) return;
          setView(data);
          setPhase("ready");
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          if (error instanceof ProfileApiError && error.code === "BASELINE_REQUIRED") {
            router.replace("/baseline");
            return;
          }
          setErrorMessage(error instanceof Error ? error.message : "加载失败，请稍后重试");
          setPhase("error");
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [retryToken, router]);

  const progressText =
    phase === "ready" && view
      ? `已了解 ${view.insight.observedCount}/${view.insight.totalCount}`
      : phase === "loading"
        ? "加载中"
        : "加载失败";

  return (
    <ProfileShell progressText={progressText}>
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-4 flex flex-wrap items-baseline gap-3">
          <h1 className="text-xl font-bold">能力画像</h1>
          <p className="text-xs text-[#94A3B8]">AI 基于你的每次作答持续更新</p>
        </div>

        {phase === "loading" ? (
          <div className={`${CARD} animate-pulse p-10 text-center text-sm text-[#94A3B8]`}>
            正在加载能力画像…
          </div>
        ) : null}

        {phase === "error" ? (
          <div className={`${CARD} p-10 text-center`}>
            <p className="text-sm text-[#475569]">{errorMessage}</p>
            <button
              type="button"
              onClick={() => {
                setErrorMessage(null);
                setPhase("loading");
                setRetryToken((prev) => prev + 1);
              }}
              className={`${PRIMARY_BTN} mt-5`}
            >
              重新加载
            </button>
          </div>
        ) : null}

        {phase === "ready" && view ? <ProfileContent view={view} /> : null}
      </div>
    </ProfileShell>
  );
}
