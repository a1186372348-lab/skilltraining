"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchTodaySession } from "../training/session/api";
import type { TodayView } from "../training/session/contract";
import { TodayShell } from "../training/session/shell";
import { TrainingFlow } from "../training/session/training-flow";

import { fetchBaselineStatus, triggerFeedback } from "./api";
import {
  baselineStageText,
  progressText,
  shouldShowIntro,
  type BaselineStatusView,
} from "./view-model";

/**
 * 能力基线测评流程页（T17a / D19 / BR-9）。
 *
 * 复用今日训练的侧边栏外壳与 TrainingFlow（训练闭环完全一致：提示/追问/评分/系数），
 * 本组件只叠加基线专属层：
 * - 开场说明卡（能力边界测绘、2 题、约 20~30 分钟、可中断恢复）；
 * - 进度指示（第 1/2、2/2 题，数据来自 GET /api/training/baseline）；
 * - 轮询推进：侦测到当前题终答 → 懒触发评分（复用反馈端点，幂等）→
 *   评分完成自动进入下一题（重挂载 TrainingFlow 加载新会话）；
 * - 最后一题评分完成 → 跳 /profile（能力边界首次揭晓）。
 *
 * 门禁兜底：老用户（required=false）进入本页直接回首页；
 * today 接口返回 kind=daily 时也视为基线已完成（例如在另一标签页完成）。
 */

const CARD =
  "rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const PRIMARY_BTN =
  "rounded-xl bg-[#2563EB] px-6 py-3 text-sm font-bold text-white shadow-[0_4px_12px_rgba(37,99,235,0.25)] transition-colors hover:bg-[#1D4ED8]";

/** 轮询间隔（评分真实延迟 35~49 秒，4 秒一档足够顺滑） */
const POLL_MS = 4000;

type Phase = "loading" | "intro" | "training" | "finishing" | "error";

/** today 视图在基线模式下的扩展字段（server today-view 下发，前端契约未含，窄化读取） */
function viewKind(view: TodayView): "baseline" | "daily" {
  return (view as TodayView & { kind?: "baseline" | "daily" }).kind === "baseline"
    ? "baseline"
    : "daily";
}

export function BaselineFlow() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<BaselineStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roundKey, setRoundKey] = useState(0);
  const [scoring, setScoring] = useState(false);
  // 已确认评完的题数（轮询据此判断何时推进下一题）
  const doneRef = useRef(0);
  // 本次访问是否产生过基线作答（决定完成后的落点：新用户 /profile，老用户 /）
  const trainedRef = useRef(false);
  // 轮询重入保护
  const tickingRef = useRef(false);

  /** 基线完成后的落点：作答过 → /profile 揭晓能力边界；未作答（老用户误入）→ 首页 */
  const complete = useCallback(
    (replace: boolean) => {
      const target = trainedRef.current ? "/profile" : "/";
      if (replace) router.replace(target);
      else router.push(target);
    },
    [router],
  );

  // 首屏：状态判定 + 当前会话加载
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const first = await fetchBaselineStatus();
        if (!first.required) {
          complete(true);
          return;
        }
        doneRef.current = first.doneCount;
        const view = await fetchTodaySession();
        if (cancelled) return;
        if (view && viewKind(view) === "daily") {
          // 竞态：状态检查后基线已完成（如另一标签页）→ 按完成处理
          complete(true);
          return;
        }
        setStatus(first);
        setPhase(shouldShowIntro(view, first.doneCount) ? "intro" : "training");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "加载失败，请稍后重试");
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [complete]);

  // 轮询：终答 → 触发评分 → 推进下一题 / 完成跳 /profile
  useEffect(() => {
    if (phase !== "training") return;
    const tick = async () => {
      if (tickingRef.current) return;
      tickingRef.current = true;
      try {
        const view = await fetchTodaySession();
        if (!view) return;
        if (viewKind(view) === "daily") {
          // 基线已完成（today 恢复返回日常题）→ 收尾跳转
          trainedRef.current = true;
          setPhase("finishing");
          complete(false);
          return;
        }
        if (!view.finalAnswer) return;
        trainedRef.current = true;
        setScoring(true);
        const feedback = await triggerFeedback(view.sessionId);
        if (feedback.status !== "ready") return; // 评分中，下轮继续
        const next = await fetchBaselineStatus();
        setStatus(next);
        if (!next.required) {
          setPhase("finishing");
          complete(false);
          return;
        }
        if (next.doneCount > doneRef.current) {
          doneRef.current = next.doneCount;
          setScoring(false);
          // 重挂载 TrainingFlow：today 接口会返回下一道基线题的会话
          setRoundKey((key) => key + 1);
        }
      } catch {
        // 轮询失败不打断训练：下轮自动重试（评分触发幂等）
      } finally {
        tickingRef.current = false;
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => clearInterval(timer);
  }, [phase, complete]);

  const stageText = status
    ? baselineStageText(status.doneCount, status.total)
    : "基线";

  return (
    <TodayShell stageText={stageText} lockViewport>
      <div className="mx-auto w-full max-w-6xl xl:flex xl:h-full xl:min-h-0 xl:max-w-7xl xl:flex-col xl:overflow-hidden">
        {phase === "loading" ? (
          <div className="grid items-start gap-5 xl:min-h-0 xl:flex-1 xl:grid-cols-[320px_minmax(0,1fr)_288px] xl:grid-rows-1">
            <div className="flex flex-col gap-5">
              <div className={`${CARD} h-72 animate-pulse bg-[#EDF1F7]`} />
              <div className={`${CARD} h-28 animate-pulse bg-[#EDF1F7]`} />
            </div>
            <div className="flex flex-col gap-5">
              <div className={`${CARD} h-32 animate-pulse bg-[#EDF1F7]`} />
              <div className={`${CARD} h-64 animate-pulse bg-[#EDF1F7]`} />
            </div>
            <div className={`${CARD} h-80 animate-pulse bg-[#EDF1F7]`} />
          </div>
        ) : null}

        {phase === "error" ? (
          <div className={`${CARD} p-10 text-center`}>
            <p className="text-sm text-[#475569]">{error ?? "加载失败，请稍后重试"}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className={`${PRIMARY_BTN} mt-5`}
            >
              重新加载
            </button>
          </div>
        ) : null}

        {phase === "intro" && status ? (
          <IntroCard total={status.total} onStart={() => setPhase("training")} />
        ) : null}

        {phase === "training" || phase === "finishing" ? (
          <>
            <header className="mb-6 flex flex-wrap items-center gap-3 xl:shrink-0">
              <span className="text-xs font-bold tracking-[0.16em] text-[#2563EB]">
                能力基线测评
              </span>
              {status ? (
                <span className="rounded-full border border-[#E9EDF4] bg-white px-3 py-1 text-xs text-[#475569]">
                  {progressText(status.doneCount, status.total)}
                </span>
              ) : null}
              {scoring ? (
                <span className="text-xs text-[#94A3B8]">
                  本题已完成，评分处理中，稍后自动进入下一步…
                </span>
              ) : null}
            </header>
            {/* key 随题号推进重挂载：加载下一道基线题的会话；withShell=false 避免双重侧边栏；redirectToFeedbackOnDone=false——终答后不跳反馈页，由本组件轮询推进下一题/跳画像页（T17a） */}
            <TrainingFlow key={roundKey} withShell={false} redirectToFeedbackOnDone={false} />
          </>
        ) : null}

        {phase === "finishing" ? (
          <div className={`${CARD} mt-5 p-8 text-center`}>
            <h3 className="text-lg font-bold">能力边界已生成</h3>
            <p className="mt-2 text-sm text-[#475569]">正在前往能力画像，首次揭晓你的能力边界…</p>
          </div>
        ) : null}
      </div>
    </TodayShell>
  );
}

/** 开场说明卡：能力边界测绘、题量与时长、可中断恢复（D19） */
function IntroCard({ total, onStart }: { total: number; onStart: () => void }) {
  return (
    <div className={`${CARD} mx-auto max-w-2xl p-10 text-center`}>
      <span className="text-xs font-bold tracking-[0.16em] text-[#2563EB]">能力基线测评</span>
      <h1 className="mt-3 text-2xl font-bold tracking-wide">先明确边界，再在边缘拓展</h1>
      <p className="mx-auto mt-4 max-w-lg text-sm leading-7 text-[#475569]">
        这是一次能力边界测绘：
        {total} 道综合案例题，合计覆盖 8 个产品能力维度，约 20~30 分钟。
        流程与日常训练一致——阅读案例、自由作答、AI 产品总监追问、提交终答，
        独立完成系数规则同样适用。
      </p>
      <ul className="mx-auto mt-6 flex max-w-md flex-col gap-2 text-left text-[13px] leading-6 text-[#475569]">
        <li className="rounded-lg border border-[#E9EDF4] bg-[#F8FAFD] px-4 py-2.5">
          中途退出可随时恢复，进度自动保存
        </li>
        <li className="rounded-lg border border-[#E9EDF4] bg-[#F8FAFD] px-4 py-2.5">
          完成后生成你的初始能力边界，并解锁日常训练
        </li>
      </ul>
      <button type="button" onClick={onStart} className={`${PRIMARY_BTN} mt-8`}>
        开始测评 ▸
      </button>
    </div>
  );
}
