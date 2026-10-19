"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, fetchTodaySession } from "../training/session/api";
import type { TodayView } from "../training/session/contract";
import { TodayShell } from "../training/session/shell";
import { TrainingFlow } from "../training/session/training-flow";

import { fetchBaselineStatus } from "./api";
import {
  baselineStageText,
  finishingProgressText,
  litDimensionCount,
  progressText,
  REVEAL_DIMENSIONS,
  shouldShowIntro,
  showDelayHint,
  transitionContinueLabel,
  transitionProgressText,
  type BaselineStatusView,
} from "./view-model";

/**
 * 能力基线测评流程页（T17a / D19 / BR-9；T36 / D38 题间并行评分）。
 *
 * 复用今日训练的侧边栏外壳与 TrainingFlow（训练闭环完全一致：提示/追问/评分/系数），
 * 本组件只叠加基线专属层：
 * - 开场说明卡（能力边界测绘、题量、约 20~30 分钟、可中断恢复）；
 * - 进度指示（按已作答口径：提交终答即算完成该题，评分在服务端后台并行，不等评分）；
 * - 题间过渡卡（T36 试测修订）：提交后不立刻切题——「已提交 ✓ + 分段进度 +
 *   评审统一揭晓预告」，用户点「进入下一题」手动继续（节奏可控，题间可停顿）；
 * - 推进：TrainingFlow 的 onFinalSubmitted 回调即时进过渡卡，4 秒轮询基线状态作兜底；
 * - 最后一题过渡卡主按钮进入「能力边界生成中」收尾页：按 doneCount/total 逐项点亮
 *   8 个能力维度，轮询直到全部评完（required=false）自动跳 /profile 首次揭晓能力边界。
 *
 * 门禁兜底：老用户（required=false）进入本页直接回首页；
 * today 接口返回 kind=daily 时视为基线已完成（例如在另一标签页完成）；
 * today 接口 409 BASELINE_SCORING_PENDING（全部已作答待评分）时直接进入收尾页。
 */

const CARD =
  "rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const PRIMARY_BTN =
  "rounded-xl bg-[#2563EB] px-6 py-3 text-sm font-bold text-white shadow-[0_4px_12px_rgba(37,99,235,0.25)] transition-colors hover:bg-[#1D4ED8]";

/** 轮询间隔（推进即时性由 onFinalSubmitted 承担，4 秒一档仅作兜底与收尾页刷新） */
const POLL_MS = 4000;

type Phase = "loading" | "intro" | "training" | "transition" | "finishing" | "error";

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
  // 题间过渡卡内容（提交后乐观置值，状态刷新后由 advance 校准为权威值）
  const [transitionInfo, setTransitionInfo] = useState<{ done: number; total: number } | null>(null);
  // 进入收尾页至今的毫秒数（超时提示判定；每次轮询刷新驱动重渲染）
  const [finishingElapsed, setFinishingElapsed] = useState(0);
  // 最近一次见到的已作答题数（推进据此判断何时加载下一题）
  const answeredRef = useRef(0);
  // 是否产生过基线作答（本次访问作答，或中断恢复时此前已作答；决定完成落点：/profile 或 /）
  const trainedRef = useRef(false);
  // 轮询重入保护
  const tickingRef = useRef(false);
  // 进入收尾页的时间戳（只记首次；超时提示的时间基准）
  const finishingSinceRef = useRef<number | null>(null);

  /** 基线完成后的落点：作答过 → /profile 揭晓能力边界；未作答（老用户误入）→ 首页 */
  const complete = useCallback(
    (replace: boolean) => {
      const target = trainedRef.current ? "/profile" : "/";
      if (replace) router.replace(target);
      else router.push(target);
    },
    [router],
  );

  /** 进入收尾页：记录进入时间（超时提示基准），重复进入不重置 */
  const enterFinishing = useCallback(() => {
    if (finishingSinceRef.current === null) finishingSinceRef.current = Date.now();
    setPhase("finishing");
  }, []);

  /**
   * 按最新基线状态推进（onFinalSubmitted 即时回调与轮询兜底共用）：
   * 全部评完 → 收尾跳 /profile；作答数增加 → 题间过渡卡（不立刻切题，手动继续）。
   */
  const advance = useCallback(
    (next: BaselineStatusView) => {
      setStatus(next);
      if (!next.required) {
        enterFinishing();
        complete(false);
        return;
      }
      if (next.answeredCount > answeredRef.current) {
        trainedRef.current = true;
        answeredRef.current = next.answeredCount;
        // 题间过渡卡（试测修订）：确认节拍 + 进度，由用户点「进入下一题」继续
        setTransitionInfo({ done: next.answeredCount, total: next.total });
        setPhase("transition");
      }
    },
    [complete, enterFinishing],
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
        answeredRef.current = first.answeredCount;
        // 中断恢复：此前已作答过题的，完成后落点同样是 /profile
        if (first.answeredCount > 0) trainedRef.current = true;
        setStatus(first);
        // 全部已作答（评分进行中）→ 直接进收尾页，不必再等 today
        if (first.answeredCount >= first.total) {
          enterFinishing();
          return;
        }
        let view: TodayView | null;
        try {
          view = await fetchTodaySession();
        } catch (err) {
          // 竞态：状态检查后最后一题恰好提交 → today 挡回 → 进收尾页
          if (err instanceof ApiError && err.code === "BASELINE_SCORING_PENDING") {
            enterFinishing();
            return;
          }
          throw err;
        }
        if (cancelled) return;
        if (view && viewKind(view) === "daily") {
          // 竞态：状态检查后基线已完成（如另一标签页）→ 按完成处理
          complete(true);
          return;
        }
        setPhase(shouldShowIntro(view, first.answeredCount) ? "intro" : "training");
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
  }, [complete, enterFinishing]);

  // 终答提交成功 → 同步进题间过渡卡（与 TrainingFlow 的提交 setState 同帧批处理，
  // 避免完成卡闪烁）；计数先按乐观值（已作答 + 1，提交已成功落库），随后刷新状态校准
  const handleFinalSubmitted = useCallback(() => {
    trainedRef.current = true;
    const total = status?.total ?? 0;
    setTransitionInfo({ done: Math.min(answeredRef.current + 1, total), total });
    setPhase("transition");
    void (async () => {
      try {
        advance(await fetchBaselineStatus());
      } catch {
        // 刷新失败不影响流程：过渡卡按乐观值呈现（提交已成功，计数准确）
      }
    })();
  }, [advance, status?.total]);

  /** 过渡卡主按钮：最后一题进收尾页（轮询等评分完成），其余重挂载 TrainingFlow 加载下一题 */
  const handleContinue = useCallback(() => {
    const info = transitionInfo;
    setTransitionInfo(null);
    if (info && info.total > 0 && info.done >= info.total) {
      enterFinishing();
      return;
    }
    setRoundKey((key) => key + 1);
    setPhase("training");
  }, [transitionInfo, enterFinishing]);

  // training 阶段轮询（兜底）：只查基线状态，按已作答口径推进
  useEffect(() => {
    if (phase !== "training") return;
    const tick = async () => {
      if (tickingRef.current) return;
      tickingRef.current = true;
      try {
        advance(await fetchBaselineStatus());
      } catch {
        // 轮询失败不打断训练：下轮自动重试（评分触发幂等）
      } finally {
        tickingRef.current = false;
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => clearInterval(timer);
  }, [phase, advance]);

  // finishing 阶段轮询：全部评完（required=false）→ 跳 /profile 揭晓；页面持续轮询不离开
  useEffect(() => {
    if (phase !== "finishing") return;
    const tick = async () => {
      if (tickingRef.current) return;
      tickingRef.current = true;
      try {
        const next = await fetchBaselineStatus();
        setStatus(next);
        setFinishingElapsed(Date.now() - (finishingSinceRef.current ?? Date.now()));
        if (!next.required) complete(false);
      } catch {
        // 轮询失败下轮自动重试（状态查询会对未评分会话补触发评分，自愈）
      } finally {
        tickingRef.current = false;
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => clearInterval(timer);
  }, [phase, complete]);

  const stageText = status
    ? baselineStageText(status.answeredCount, status.total)
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

        {phase === "training" ? (
          <>
            <header className="mb-6 flex flex-wrap items-center gap-3 xl:shrink-0">
              <span className="text-xs font-bold tracking-[0.16em] text-[#2563EB]">
                能力基线测评
              </span>
              {status ? (
                <span className="rounded-full border border-[#E9EDF4] bg-white px-3 py-1 text-xs text-[#475569]">
                  {progressText(status.answeredCount, status.total)}
                </span>
              ) : null}
            </header>
            {/* key 随题号推进重挂载：加载下一道基线题的会话；withShell=false 避免双重侧边栏；
                redirectToFeedbackOnDone=false——终答后不跳反馈页，由本组件经 onFinalSubmitted 即时推进（T36） */}
            <TrainingFlow
              key={roundKey}
              withShell={false}
              redirectToFeedbackOnDone={false}
              onFinalSubmitted={handleFinalSubmitted}
            />
          </>
        ) : null}

        {phase === "transition" && transitionInfo ? (
          <TransitionCard
            done={transitionInfo.done}
            total={transitionInfo.total}
            onContinue={handleContinue}
          />
        ) : null}

        {phase === "finishing" ? (
          <FinishingCard
            doneCount={status?.doneCount ?? 0}
            total={status?.total ?? 0}
            elapsedMs={finishingElapsed}
          />
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

/**
 * 题间过渡卡（T36 试测修订 / D38 配套）：提交终答后的确认节拍——
 * 「已提交 ✓」+ 分段进度条 + 「评审将在全部完成后统一揭晓」预期管理；
 * 手动进入下一题（用户掌控节奏，题间可停顿）；最后一题主按钮进入收尾页。
 */
function TransitionCard({
  done,
  total,
  onContinue,
}: {
  done: number;
  total: number;
  onContinue: () => void;
}) {
  return (
    <div className={`${CARD} mx-auto max-w-2xl p-10 text-center`}>
      <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-[#ECFDF5] text-lg text-[#047857]">
        ✓
      </div>
      <h2 className="text-lg font-bold">本题已提交</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#475569]">
        本题的评审将在全部完成后统一揭晓。准备好后继续。
      </p>
      {/* 分段进度条（组件语言）：每段一题，已作答点亮 */}
      <div className="mx-auto mt-6 flex max-w-md items-center gap-1.5">
        {Array.from({ length: Math.max(total, 0) }, (_, index) => (
          <span
            key={index}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              index < done ? "bg-[#2563EB]" : "bg-[#E2E8F0]"
            }`}
          />
        ))}
      </div>
      <p className="mt-3 text-xs font-medium text-[#94A3B8]">
        {transitionProgressText(done, total)}
      </p>
      <button type="button" onClick={onContinue} className={`${PRIMARY_BTN} mt-7`}>
        {transitionContinueLabel(done, total)}
      </button>
    </div>
  );
}

/**
 * 收尾页（T36 / D38）：「能力边界生成中」——全部作答已提交，评分在后台并行进行；
 * 8 个能力维度按评分完成进度（doneCount/total）逐项点亮，营造揭晓仪式感；
 * 超过约 3 分钟未评完时追加预期管理文案，页面持续轮询不离开。
 */
function FinishingCard({
  doneCount,
  total,
  elapsedMs,
}: {
  doneCount: number;
  total: number;
  elapsedMs: number;
}) {
  const litCount = litDimensionCount(doneCount, total);
  return (
    <div className={`${CARD} mx-auto w-full max-w-2xl p-10 text-center`}>
      <span className="text-xs font-bold tracking-[0.16em] text-[#2563EB]">能力基线测评</span>
      <h1 className="mt-3 text-2xl font-bold tracking-wide">能力边界生成中</h1>
      <p className="mx-auto mt-4 max-w-lg text-sm leading-7 text-[#475569]">
        全部作答已提交，AI 产品总监正在逐题评审，完成后自动揭晓。
      </p>
      <p className="mt-5 text-sm font-semibold text-[#12233F]">
        {finishingProgressText(doneCount, total)}
      </p>
      <ul className="mx-auto mt-5 grid max-w-md grid-cols-2 gap-2.5 text-left">
        {REVEAL_DIMENSIONS.map((dimension, index) => {
          const lit = index < litCount;
          return (
            <li
              key={dimension}
              className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 transition-colors ${
                lit ? "border-[#D9E7FD] bg-[#EFF5FF]" : "border-[#E9EDF4] bg-[#F8FAFD]"
              }`}
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition-colors ${
                  lit ? "bg-[#2563EB] text-white" : "bg-[#E2E8F0] text-[#94A3B8]"
                }`}
              >
                {lit ? "✓" : index + 1}
              </span>
              <span
                className={`text-[13px] font-medium transition-colors ${
                  lit ? "text-[#12233F]" : "text-[#94A3B8]"
                }`}
              >
                {dimension}
              </span>
            </li>
          );
        })}
      </ul>
      {showDelayHint(elapsedMs) ? (
        <p className="mt-5 text-xs leading-5 text-[#94A3B8]">
          生成时间比预期长，正在自动重试，你可以留在本页稍候。
        </p>
      ) : null}
    </div>
  );
}
