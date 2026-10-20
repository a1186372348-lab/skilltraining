"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import {
  ApiError,
  fetchSessionById,
  fetchTodaySession,
  requestFollowupHint,
  requestHint,
  retryFollowups,
  startExtraSession,
  submitFinalAnswer,
  submitFirstAnswer,
} from "./api";
import type { FollowupRound, TodayView } from "./contract";
import { TodayShell } from "./shell";
import type { ChatMessage, FollowupFailureMode, FollowupPanelMode, MaterialView } from "./view-model";
import {
  FOLLOWUP_GATE_SKIP_MESSAGE,
  MAX_HINT_LAYERS,
  THINKING_DIRECTIONS,
  buildFollowupMessages,
  canSubmitAnswer,
  followupEmptyState,
  followupFailureMode,
  followupInputPlaceholder,
  followupPanelMode,
  formatCoefficient,
  hintMicrocopy,
  isFollowupInputVisible,
  isHintButtonVisible,
  stageLabel,
  stageOfSession,
  toCaseFieldViews,
  toCaseSourceViews,
  toMaterialViews,
} from "./view-model";

/**
 * 训练工作台交互主体（P3；T25 / D27 起按会话寻址：/training/session/[id]）。
 * 状态流：作答（可请求提示）→ 首答提交 → 总监追问 → 终答提交 → 直接跳转反馈页
 * （2026-10-07 修正，对齐 Prd.md 核心链路与原型屏 2，取代内嵌完成卡过渡实现；
 * 基线测评复用时置 redirectToFeedbackOnDone=false，由 BaselineFlow 轮询推进）；
 * 刷新后由 GET /api/training/[id] 返回的会话状态恢复到对应阶段（R4）——
 * 已完成阶段重访仍渲染内嵌完成卡，作为回看入口（附反馈页链接）。
 * 基线会话由服务端拒绝（BASELINE_SESSION），本组件据 code 重定向 /baseline。
 * 追问生成失败态（T37 / D39）：隐藏作答输入区，提供「重试本次对话」（followup-retry，幂等）
 * 与「跳过追问，直接作答」逃生口；重试中复用「总监思考中…」生成中样式。
 * 全部状态→视图判定走 view-model 纯函数，本组件只负责渲染与调用适配层。
 */

const CARD =
  "rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const PRIMARY_BTN =
  "rounded-xl bg-[#2563EB] px-6 py-3 text-sm font-bold text-white shadow-[0_4px_12px_rgba(37,99,235,0.25)] transition-colors hover:bg-[#1D4ED8] disabled:cursor-not-allowed disabled:bg-[#94A3B8] disabled:shadow-none";
const TEXTAREA =
  "w-full resize-y rounded-xl border border-[#E9EDF4] bg-white px-4 py-3 text-sm leading-6 text-[#0F172A] outline-none transition-colors placeholder:text-[#94A3B8] focus:border-[#2563EB]";

type PendingAction = "hint" | "first" | "final" | "followup-hint" | "followup-retry" | "extra" | null;

export function TrainingFlow({
  withShell = true,
  redirectToFeedbackOnDone = true,
  sessionId,
  onFinalSubmitted,
}: {
  withShell?: boolean;
  /** 终答提交成功后直接跳转反馈页 P4；基线测评复用时置 false（由 BaselineFlow 推进下一题/跳画像页） */
  redirectToFeedbackOnDone?: boolean;
  /**
   * T25 / D27：按会话寻址（/training/session/[id]，GET /api/training/[id]）；
   * 缺省走 GET /api/training/today（baseline 复用路径：基线门禁下 today 返回当前基线会话）
   */
  sessionId?: string;
  /**
   * T36 / D38：终答提交成功后回调一次（仅 redirectToFeedbackOnDone=false 的基线复用模式），
   * BaselineFlow 借此立即刷新状态推进下一题，轮询仅作兜底
   */
  onFinalSubmitted?: () => void;
}) {
  const router = useRouter();
  const [payload, setPayload] = useState<TodayView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [draft, setDraft] = useState("");
  const [finalDraft, setFinalDraft] = useState("");
  // T22：提交首答的响应追问为空（服务端重试已耗尽的确定失败）时置 true，直接按失败渲染；
  // 会话变化/重新 load 后重置
  const [followupFailed, setFollowupFailed] = useState(false);
  // T37 / D39：失败态「跳过追问，直接作答」逃生口——展开输入区直接终答；load 后重置
  const [followupSkipped, setFollowupSkipped] = useState(false);
  // T37 / D39：「重试本次对话」未成功的就地提示（按钮旁「重试未成功…」）；load/重试发起后重置
  const [retryFailed, setRetryFailed] = useState(false);
  // T22：最近一次 load 完成的时间戳，作为「生成中」窗口判定的当前时间基准（渲染期不调 Date.now）
  const [payloadLoadedAt, setPayloadLoadedAt] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setPayload(sessionId ? await fetchSessionById(sessionId) : await fetchTodaySession());
      setPayloadLoadedAt(Date.now());
      setFollowupFailed(false);
      setFollowupSkipped(false);
      setRetryFailed(false);
    } catch (error) {
      // T25：基线会话不属于日常工作台（服务端 409 BASELINE_SESSION）→ 回基线独立入口；
      // T36 / D38：基线全部已作答待评分（409 BASELINE_SCORING_PENDING）同样挡回 /baseline 收尾页
      if (
        error instanceof ApiError &&
        (error.code === "BASELINE_SESSION" || error.code === "BASELINE_SCORING_PENDING")
      ) {
        router.replace("/baseline");
        return;
      }
      // T38 / D40：会话已终止（他端重启或历史旧链接）→ 回训练大厅重新开始
      if (error instanceof ApiError && error.code === "SESSION_ABANDONED") {
        router.replace("/training");
        return;
      }
      setLoadError(error instanceof Error ? error.message : "加载失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, [sessionId, router]);

  useEffect(() => {
    // 首屏加载延迟到 effect 同步阶段之后执行，避免同步 setState 引发级联渲染
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  /** 请求下一层提示：合并服务端返回的提示层、次数与权威系数 */
  const onRequestHint = useCallback(async () => {
    if (!payload || pendingAction) return;
    setPendingAction("hint");
    setActionError(null);
    try {
      const res = await requestHint(payload.sessionId);
      setPayload((prev) =>
        prev
          ? {
              ...prev,
              state: res.state,
              hintCount: res.hintCount,
              coefficient: res.coefficient,
              canRequestHint: res.hintCount < MAX_HINT_LAYERS,
              releasedHints: [...prev.releasedHints, res.hint],
            }
          : prev,
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "请求提示失败，请重试");
    } finally {
      setPendingAction(null);
    }
  }, [payload, pendingAction]);

  /** 提交首答：状态推进到追问，提示按钮永久消失（D7） */
  const onSubmitFirst = useCallback(async () => {
    if (!payload || pendingAction || !canSubmitAnswer(draft)) return;
    setPendingAction("first");
    setActionError(null);
    try {
      const res = await submitFirstAnswer(payload.sessionId, draft.trim());
      // T22：响应追问为空 = 服务端重试已耗尽的确定失败，直接按失败渲染（不走 120 秒窗口）；
      // T35：闸门判定无需追问（followupGateSkipped）不是失败——切正向零追问卡
      setFollowupFailed(res.followups.length === 0 && res.followupGateSkipped !== true);
      setPayload((prev) =>
        prev
          ? {
              ...prev,
              state: res.state,
              firstAnswer: res.firstAnswer,
              followups: res.followups,
              followupGateSkipped: res.followupGateSkipped === true,
              coefficient: res.coefficient,
              canRequestHint: false,
            }
          : prev,
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "提交失败，请重试");
    } finally {
      setPendingAction(null);
    }
  }, [payload, pendingAction, draft]);

  /** 提交终答：日常训练直接跳转反馈页（评分等待态由反馈页承接）；基线复用模式回调 onFinalSubmitted 立即推进（T36）；接口幂等，重复点击不覆盖不重复计分 */
  const onSubmitFinal = useCallback(async () => {
    if (!payload || pendingAction || !canSubmitAnswer(finalDraft)) return;
    setPendingAction("final");
    setActionError(null);
    try {
      const res = await submitFinalAnswer(payload.sessionId, finalDraft.trim());
      setPayload((prev) =>
        prev ? { ...prev, state: res.state, finalAnswer: res.finalAnswer } : prev,
      );
      if (redirectToFeedbackOnDone) {
        router.push(`/training/feedback/${payload.sessionId}`);
      } else {
        onFinalSubmitted?.();
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "提交失败，请重试");
    } finally {
      setPendingAction(null);
    }
  }, [payload, pendingAction, finalDraft, redirectToFeedbackOnDone, onFinalSubmitted, router]);

  /** 释放某轮追问的预生成提示（T19 / D22）：读库响应零等待；就地展开并同步组合系数 */
  const onRequestFollowupHint = useCallback(
    async (round: number) => {
      if (!payload || pendingAction) return;
      setPendingAction("followup-hint");
      setActionError(null);
      try {
        const res = await requestFollowupHint(payload.sessionId, round);
        setPayload((prev) =>
          prev
            ? {
                ...prev,
                coefficient: res.coefficient,
                followupHintCount: res.followupHintCount,
                followups: prev.followups.map((item) =>
                  item.round === round ? { ...item, hintReleased: true, hint: res.hint } : item,
                ),
              }
            : prev,
        );
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "请求提示失败，请重试");
      } finally {
        setPendingAction(null);
      }
    },
    [payload, pendingAction],
  );

  /**
   * 重试本次对话（T37 / D39）：追问生成失败后的用户侧重新生成入口。
   * 接口幂等（已有追问直接返回）；成功就地渲染追问气泡并恢复输入区；
   * 再次失败（空追问）或请求级失败都回失败态，就地提示可再试或跳过。
   */
  const onRetryFollowup = useCallback(async () => {
    if (!payload || pendingAction) return;
    setPendingAction("followup-retry");
    setActionError(null);
    setRetryFailed(false);
    try {
      const res = await retryFollowups(payload.sessionId);
      if (res.followupGateSkipped === true) {
        // T35：重试后闸门判定无需追问——切正向零追问卡（非失败态）
        setFollowupFailed(false);
        setFollowupSkipped(false);
        setPayload((prev) =>
          prev
            ? {
                ...prev,
                state: res.state,
                followups: res.followups,
                followupGateSkipped: true,
                coefficient: res.coefficient,
              }
            : prev,
        );
        return;
      }
      if (res.followups.length === 0) {
        // 重试仍未成功（语义与首答一致：空追问 = 失败）
        setRetryFailed(true);
        return;
      }
      setFollowupFailed(false);
      setFollowupSkipped(false);
      setPayload((prev) =>
        prev
          ? {
              ...prev,
              state: res.state,
              followups: res.followups,
              followupGateSkipped: false,
              coefficient: res.coefficient,
            }
          : prev,
      );
    } catch (error) {
      // T35：闸门跳过会话被守卫拒绝（409 FOLLOWUP_GATE_SKIPPED）——重新拉取会话切正向零追问卡
      if (error instanceof ApiError && error.code === "FOLLOWUP_GATE_SKIPPED") {
        void load();
        return;
      }
      // 请求级失败同样回失败态并就地提示（保留重试/跳过出口）
      setRetryFailed(true);
    } finally {
      setPendingAction(null);
    }
  }, [payload, pendingAction, load]);

  /** 跳过追问直接作答（T37 / D39 逃生口）：展开输入区，placeholder 引导直接终答 */
  const onSkipFollowup = useCallback(() => {
    setFollowupSkipped(true);
    setRetryFailed(false);
  }, []);

  /** 再练一题（T21 / D3）：创建/复用加练会话后进入新题工作台；失败行内提示 */
  const onStartExtra = useCallback(async () => {
    if (pendingAction) return;
    setPendingAction("extra");
    setActionError(null);
    try {
      const res = await startExtraSession();
      if (sessionId) {
        // 按会话寻址模式（T25）：直接跳新加练会话的工作台
        router.push(`/training/session/${res.sessionId}`);
      } else {
        // today 加载模式（baseline 复用路径）：重新拉取即返回新加练会话
        await load();
      }
    } catch (error) {
      // T36 / D38：基线未完成 → 挡回基线测评（服务端 409 BASELINE_REQUIRED）
      if (error instanceof ApiError && error.code === "BASELINE_REQUIRED") {
        router.push("/baseline");
        return;
      }
      setActionError(error instanceof Error ? error.message : "创建加练失败，请重试");
    } finally {
      setPendingAction(null);
    }
  }, [pendingAction, load, sessionId, router]);

  const stage = payload ? stageOfSession(payload.state, payload.finalAnswer) : "answering";
  const stageText = loading && !payload ? "加载中" : stageLabel(stage);
  // T20 交付项 9：自然高度 + 封顶——卡片一律保持自然内容高度，xl 起各栏 max-h-full 封顶；左右栏超高时卡片内容区内滚（外壳与标题不动），
  // 中栏作答/完成阶段栏级滚动，仅追问阶段改为整体对话卡（栏锁定，滚动在消息区内部，输入条钉在卡底）
  const isFollowup = stage === "followup";

  // T35 / D37：追问区三态——rounds 现状气泡 / gate-skip 正向零追问卡 / empty 生成中与失败通道
  const panelMode: FollowupPanelMode =
    payload && isFollowup
      ? followupPanelMode(payload.followups.length, payload.followupGateSkipped === true)
      : "rounds";

  // T22：追问为空时区分生成中/失败——提交响应即空直接失败；否则按首答提交后 120 秒窗口判定
  // （当前时间取最近一次 load 完成时间：渲染期保持纯净，每次轮询重拉后窗口自动重估）；
  // T35：闸门跳过（gate-skip）不进本通道——无生成中等待、无轮询、无失败兜底
  const followupEmpty =
    payload && isFollowup && panelMode === "empty"
      ? followupFailed
        ? "failed"
        : followupEmptyState(payload.firstSubmittedAt, payloadLoadedAt)
      : null;

  // T37 / D39：失败态判定下沉 view-model 纯函数——failed 隐藏输入区并给重试/跳过出口，skipped 恢复输入区直接终答
  const failureMode: FollowupFailureMode =
    payload && isFollowup
      ? followupFailureMode(payload.followups.length > 0, followupEmpty, followupSkipped)
      : "none";

  // T22：生成中每 5 秒重拉；追问到达或超窗后 followupEmpty 转非 generating，依赖变化自动停止轮询
  useEffect(() => {
    if (followupEmpty !== "generating") return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [followupEmpty, load]);

  const content = (
    <div className="mx-auto w-full max-w-6xl xl:flex xl:min-h-0 xl:max-w-7xl xl:flex-1 xl:flex-col xl:overflow-hidden">
        {loading && !payload ? <LoadingView /> : null}

        {loadError ? (
          <div className={`${CARD} p-10 text-center`}>
            <p className="text-sm text-[#475569]">{loadError}</p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-4">
              <button type="button" onClick={() => void load()} className={PRIMARY_BTN}>
                重新加载
              </button>
              {/* T25：按会话寻址新增「会话不存在」场景（404）——给出回大厅的出口 */}
              <Link href="/training" className="text-sm font-medium text-[#2563EB] hover:underline">
                返回产品训练 →
              </Link>
            </div>
          </div>
        ) : null}

        {!loading && !loadError && !payload ? (
          <div className={`${CARD} p-10 text-center`}>
            <h1 className="text-lg font-bold">今天暂时没有可训练的题目</h1>
            <p className="mt-2 text-sm text-[#94A3B8]">明日再来，或回到首页查看你的成长状态。</p>
            <Link
              href="/"
              className="mt-5 inline-block text-sm font-medium text-[#2563EB] hover:underline"
            >
              返回首页 →
            </Link>
          </div>
        ) : null}

        {payload ? (
          <>
            {/* 三栏工作台（D23）：xl 起锁定单行高度、各栏自然排布 + 封顶内滚；xl 以下 order 恢复原有纵向堆叠次序 */}
            <div className="grid items-start gap-5 xl:min-h-0 xl:flex-1 xl:grid-cols-[320px_minmax(0,1fr)_288px] xl:grid-rows-1">
              {/* 左栏：案例卡 + 训练重点自然竖排；xl 起封顶，超高时案例卡内容区内滚（重点小卡 shrink-0 始终完整） */}
              <div className="order-1 flex min-h-0 flex-col gap-5 xl:order-none xl:max-h-full">
                <CaseCard payload={payload} />
                <FocusCard abilityTags={payload.abilityTags} />
              </div>

              {/* 中栏：今日问题卡 + 各阶段交互区自然排布；xl 起封顶——作答/完成阶段栏内滚动，追问阶段栏锁定、滚动在对话消息区内部 */}
              <div
                className={`order-3 flex min-w-0 flex-col gap-5 xl:order-none xl:max-h-full ${
                  isFollowup ? "xl:overflow-hidden" : "scrollbar-subtle xl:overflow-y-auto"
                }`}
              >
                <section className={`${CARD} p-7 xl:shrink-0`}>
                  <span className="mb-3 block text-[11px] font-bold tracking-[0.14em] text-[#7C8AA5]">
                    今日问题
                  </span>
                  <h1 className="text-xl leading-relaxed font-bold text-[#12233F]">
                    {payload.mainQuestion}
                  </h1>
                </section>

                {stage === "answering" ? (
                  <AnsweringSection
                    payload={payload}
                    draft={draft}
                    pendingAction={pendingAction}
                    onDraftChange={setDraft}
                    onRequestHint={() => void onRequestHint()}
                    onSubmitFirst={() => void onSubmitFirst()}
                  />
                ) : null}

                {stage === "followup" ? (
                  <FollowupSection
                    payload={payload}
                    panelMode={panelMode}
                    emptyState={followupEmpty}
                    failureMode={failureMode}
                    retryFailed={retryFailed}
                    finalDraft={finalDraft}
                    pendingAction={pendingAction}
                    onFinalDraftChange={setFinalDraft}
                    onSubmitFinal={() => void onSubmitFinal()}
                    onRequestFollowupHint={(round) => void onRequestFollowupHint(round)}
                    onRetryFollowup={() => void onRetryFollowup()}
                    onSkipFollowup={onSkipFollowup}
                  />
                ) : null}

                {stage === "done" ? (
                  <DoneSection
                    sessionId={payload.sessionId}
                    finalAnswer={payload.finalAnswer}
                    pendingAction={pendingAction}
                    // 基线复用模式（kind=baseline）不出「再练一题」入口（T21：加练不影响基线流程；
                    // kind 为服务端 today 视图下发字段，窄化读取同 BaselineFlow.viewKind）
                    onStartExtra={
                      (payload as TodayView & { kind?: string }).kind === "baseline"
                        ? null
                        : () => void onStartExtra()
                    }
                  />
                ) : null}

                <ReleasedHintsCard payload={payload} />

                {actionError ? (
                  <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                    {actionError}
                  </p>
                ) : null}
              </div>

              {/* 右栏：参考资料卡自然高度（D23 自左栏底部迁入；xl 以下经 order 仍排在案例/重点之后、问题区之前）；xl 起封顶，超高时卡内容区内滚 */}
              <div className="order-2 flex min-h-0 flex-col gap-5 xl:order-none xl:max-h-full">
                <MaterialsCard materials={toMaterialViews(payload.materials)} />
              </div>
            </div>
          </>
        ) : null}
      </div>
  );

  // /baseline 复用时外层 BaselineFlow 已带 TodayShell，避免嵌套出双重侧边栏
  if (!withShell) {
    return content;
  }

  return (
    <TodayShell stageText={stageText} lockViewport>
      {content}
    </TodayShell>
  );
}

/** 加载骨架（评分等待同样克制，R5 骨架屏原则）；自然高度版本，与三栏同构（左案例+重点、中问题+交互、右资料），避免骨架跳动 */
function LoadingView() {
  return (
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
  );
}

/** 今日案例卡：五字段事实（字段结尾内联引用链接，T13 / BR-8）；xl 起外壳与标题固定、超高时字段区内滚（pr-2 避让非悬浮滚动条） */
function CaseCard({ payload }: { payload: TodayView }) {
  const fields = toCaseFieldViews(payload.caseBackground, toCaseSourceViews(payload.caseSources));
  return (
    <section className={`${CARD} p-6 xl:flex xl:min-h-0 xl:flex-col`}>
      <span className="mb-3 block text-xs font-bold tracking-[0.16em] text-[#2563EB] xl:shrink-0">
        今日案例
      </span>
      <h2 className="mb-4 text-base leading-7 font-bold xl:shrink-0">{payload.caseTitle}</h2>
      <dl className="scrollbar-subtle flex flex-col gap-3 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-2">
        {fields.map((field) => (
          <div key={field.key} className="grid grid-cols-[64px_1fr] gap-2 text-xs leading-5">
            <dt className="shrink-0 text-[#94A3B8]">{field.label}</dt>
            <dd className="text-[#475569]">
              {field.text}
              {field.citations.map((link) => (
                <Fragment key={link.label}>
                  {" "}
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={link.title}
                    className="text-[11px] font-medium text-[#2563EB] hover:underline"
                  >
                    {link.label}
                  </a>
                </Fragment>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** 训练重点小卡：今天练什么（能力标签即评分维度，BR-1）；xl 起 shrink-0 永远完整可见，不参与左栏收缩 */
function FocusCard({ abilityTags }: { abilityTags: string[] }) {
  return (
    <section className="rounded-2xl border border-[#D9E7FD] bg-[#EFF5FF] p-6 xl:shrink-0">
      <span className="mb-2 block text-[13px] font-bold text-[#1D4ED8]">
        <span className="mr-1">★</span>训练重点
      </span>
      <div className="mb-3 flex flex-wrap gap-2">
        {abilityTags.map((tag) => (
          <span
            key={tag}
            className="rounded-lg border border-[#D9E7FD] bg-white px-2.5 py-1 text-xs font-medium text-[#2563EB]"
          >
            {tag}
          </span>
        ))}
      </div>
      <p className="text-xs leading-5 text-[#3D5A90]">
        今天主要训练以上 {abilityTags.length} 个维度，本次仅按它们评分。
      </p>
    </section>
  );
}

/** 参考资料卡：★核心 2 篇在前，○扩展 3 篇在后；阅读不扣分（BR-3）；xl 起外壳与标题行固定、超高时列表区内滚（pr-2 避让非悬浮滚动条） */
function MaterialsCard({ materials }: { materials: MaterialView[] }) {
  return (
    <section className={`${CARD} p-6 xl:flex xl:min-h-0 xl:flex-col`}>
      <div className="mb-4 flex items-baseline justify-between gap-2 xl:shrink-0">
        <h3 className="text-[15px] font-bold">参考资料</h3>
        <span className="text-[11px] whitespace-nowrap text-[#94A3B8]">阅读不扣分</span>
      </div>
      <ul className="scrollbar-subtle flex flex-col gap-4 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-2">
        {materials.map((item) => (
          <li key={`${item.kind}-${item.title}`} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  item.kind === "core"
                    ? "bg-[#FDF0D9] text-[#B45309]"
                    : "bg-[#F1F5F9] text-[#64748B]"
                }`}
              >
                {item.badge}
              </span>
              <span className="text-[13px] leading-5 font-medium text-[#0F172A]">{item.title}</span>
            </div>
            <p className="text-xs leading-5 text-[#475569]">{item.summary}</p>
            <div className="flex items-center gap-2 text-[11px] text-[#94A3B8]">
              <span>{item.source}</span>
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium text-[#2563EB] hover:underline"
              >
                原文链接 ↗
              </a>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 作答阶段：自由回答 + 提示按钮（含系数微文案，D12） */
function AnsweringSection({
  payload,
  draft,
  pendingAction,
  onDraftChange,
  onRequestHint,
  onSubmitFirst,
}: {
  payload: TodayView;
  draft: string;
  pendingAction: PendingAction;
  onDraftChange: (value: string) => void;
  onRequestHint: () => void;
  onSubmitFirst: () => void;
}) {
  const hintVisible = isHintButtonVisible("answering", payload.hintCount, payload.canRequestHint);
  return (
    <section className={`${CARD} p-7`}>
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-bold">我的回答</h3>
        <span className="text-xs text-[#94A3B8]">作答后，AI 产品总监将追问并给出诊断</span>
      </div>
      <textarea
        className={`${TEXTAREA} min-h-40`}
        placeholder="想好就写，不设格式。卡住时可以逐级请求提示。"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
      />
      <p className="mt-2 text-xs text-[#94A3B8]">
        思考方向（非必填）：{THINKING_DIRECTIONS.join(" · ")}
      </p>
      <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          {hintVisible ? (
            <>
              <button
                type="button"
                onClick={onRequestHint}
                disabled={pendingAction !== null}
                className="rounded-xl border border-dashed border-[#2563EB]/50 px-4 py-2.5 text-sm font-semibold text-[#2563EB] transition-colors hover:bg-[#EFF5FF] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pendingAction === "hint" ? "释放中…" : "◇ 给我一个提示"}
              </button>
              <span className="text-xs text-[#94A3B8]">
                {hintMicrocopy(payload.coefficient, payload.hintCount)} · 已释放{" "}
                {payload.hintCount}/{MAX_HINT_LAYERS} 层
              </span>
            </>
          ) : (
            <span className="text-xs text-[#94A3B8]">
              5 层提示已全部释放 · 当前 {formatCoefficient(payload.coefficient)}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onSubmitFirst}
          disabled={!canSubmitAnswer(draft) || pendingAction !== null}
          className={PRIMARY_BTN}
        >
          {pendingAction === "first" ? "提交中…" : "提交答案"}
        </button>
      </div>
    </section>
  );
}

/** 追问阶段：单一对话卡（T20 追加改版）——标题行 + 消息历史区（xl 起内部滚动、自动滚底）+ 底部紧凑输入条（shrink-0，始终完整可见）；每轮追问提示入口保留在对应消息旁（T19/D22）；追问为空时按 emptyState 区分生成中等待卡/失败兜底（T22）；失败态隐藏输入区并提供「重试本次对话」+「跳过追问，直接作答」出口（T37 / D39）；闸门判定无需追问时渲染正向零追问卡、输入区即终答输入框（T35 / D37） */
function FollowupSection({
  payload,
  panelMode,
  emptyState,
  failureMode,
  retryFailed,
  finalDraft,
  pendingAction,
  onFinalDraftChange,
  onSubmitFinal,
  onRequestFollowupHint,
  onRetryFollowup,
  onSkipFollowup,
}: {
  payload: TodayView;
  /** 追问区三态（T35 / D37）：rounds 现状气泡 / gate-skip 正向零追问卡 / empty 生成中与失败通道 */
  panelMode: FollowupPanelMode;
  /** 追问为空时的状态（T22：generating 显示等待卡并轮询，failed 显示兜底）；null 表示追问非空或不适用 */
  emptyState: "generating" | "failed" | null;
  /** 失败态渲染模式（T37 / D39）：failed 隐藏输入区 + 重试/跳过出口；skipped 恢复输入区直接终答 */
  failureMode: FollowupFailureMode;
  /** 重试未成功的就地提示（按钮旁「重试未成功，可再试一次或跳过追问」） */
  retryFailed: boolean;
  finalDraft: string;
  pendingAction: PendingAction;
  onFinalDraftChange: (value: string) => void;
  onSubmitFinal: () => void;
  onRequestFollowupHint: (round: number) => void;
  onRetryFollowup: () => void;
  onSkipFollowup: () => void;
}) {
  const messages = buildFollowupMessages(payload.firstAnswer, payload.followups);
  const userBubble = messages.find((message) => message.role === "user");
  // T37：重试期间复用「生成中」等待卡样式（总监思考中…）
  const retrying = pendingAction === "followup-retry";
  const showGenerating = panelMode === "empty" && (emptyState === "generating" || retrying);
  const showFailure = panelMode === "empty" && failureMode === "failed" && !retrying;
  const showGateSkip = panelMode === "gate-skip";
  const inputVisible = isFollowupInputVisible(failureMode);
  // T20 交付项 7：进入追问阶段或新追问到达时消息区滚到底部；仅消息数变化触发，用户手动上翻不回弹
  const messageListRef = useRef<HTMLDivElement>(null);
  const messageCount = messages.length;
  useEffect(() => {
    const list = messageListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messageCount]);
  // 对话卡随中栏封顶（xl:min-h-0 可被压缩）：对话短时整卡自然高；对话长时卡被压缩、消息区独立滚动；底部输入条 shrink-0 始终完整可见
  return (
    <section className={`${CARD} p-7 xl:flex xl:min-h-0 xl:flex-col`}>
      <div className="mb-5 flex items-baseline justify-between xl:shrink-0">
        <h3 className="text-[15px] font-bold">总监追问</h3>
        <span className="text-xs text-[#94A3B8]">追问不扣分，放心补充</span>
      </div>
      <div
        ref={messageListRef}
        className="scrollbar-subtle flex flex-col gap-5 xl:min-h-0 xl:flex-1 xl:overflow-y-auto"
      >
        {userBubble ? <ChatBubble message={userBubble} /> : null}
        {payload.followups.map((round) => (
          <Fragment key={round.round}>
            <ChatBubble
              message={{ role: "director", content: round.question, isFollowup: true }}
            />
            <FollowupHintBlock
              round={round}
              pendingAction={pendingAction}
              onRequest={() => onRequestFollowupHint(round.round)}
            />
          </Fragment>
        ))}
        {showGateSkip ? (
          // T35 / D37：正向零追问卡（闸门判定首答足够扎实）——好答案不再被强制追问打扰
          <div className="rounded-xl border border-dashed border-[#86EFAC] bg-[#F0FDF4] px-4 py-3 text-xs leading-5 text-[#166534]">
            <p className="font-semibold text-[#14532D]">首答足够扎实 ✓</p>
            <p className="mt-1">{FOLLOWUP_GATE_SKIP_MESSAGE}</p>
          </div>
        ) : null}
        {showGenerating ? (
          <div className="rounded-xl border border-dashed border-[#C6D3E6] bg-[#F8FAFD] px-4 py-3 text-xs leading-5 text-[#475569]">
            <p className="font-semibold text-[#12233F]">总监思考中…</p>
            <p className="mt-1">
              正在针对你的回答设计追问，通常 20 秒内，高负载时约 1 分钟。页面会自动刷新，无需操作。
            </p>
          </div>
        ) : null}
        {showFailure ? (
          <div className="rounded-xl border border-dashed border-[#C6D3E6] bg-[#F8FAFD] px-4 py-3 text-xs leading-5 text-[#475569]">
            <p className="font-semibold text-[#12233F]">总监暂时离开（追问生成失败）</p>
            <p className="mt-1">不影响本次训练——可重试生成追问，或跳过追问直接作答最终答案。</p>
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={onRetryFollowup}
                disabled={pendingAction !== null}
                className="rounded-lg bg-[#2563EB] px-4 py-2 text-xs font-bold text-white shadow-[0_2px_8px_rgba(37,99,235,0.25)] transition-colors hover:bg-[#1D4ED8] disabled:cursor-not-allowed disabled:bg-[#94A3B8] disabled:shadow-none"
              >
                重试本次对话
              </button>
              <button
                type="button"
                onClick={onSkipFollowup}
                disabled={pendingAction !== null}
                className="text-xs font-medium text-[#2563EB] hover:underline disabled:cursor-not-allowed disabled:opacity-60"
              >
                跳过追问，直接作答
              </button>
            </div>
            {retryFailed ? (
              <p className="mt-2 text-[#B45309]">重试未成功，可再试一次或跳过追问。</p>
            ) : null}
          </div>
        ) : null}
      </div>
      {inputVisible ? (
        <div className="mt-5 border-t border-[#E9EDF4] pt-5 xl:shrink-0">
          <textarea
            className={`${TEXTAREA} min-h-20`}
            placeholder={followupInputPlaceholder(failureMode, panelMode)}
            value={finalDraft}
            onChange={(event) => onFinalDraftChange(event.target.value)}
          />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
            <span className="text-xs text-[#94A3B8]">
              本题提示 {payload.hintCount} 次 · 追问提示 {payload.followupHintCount ?? 0} 次 ·
              独立完成系数 {formatCoefficient(payload.coefficient)}
            </span>
            <button
              type="button"
              onClick={onSubmitFinal}
              disabled={!canSubmitAnswer(finalDraft) || pendingAction !== null}
              className={PRIMARY_BTN}
            >
              {pendingAction === "final" ? "提交中…" : "提交最终答案"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * 单轮追问的提示区（T19 / D22）：
 * - 未释放且该轮有预生成提示：显示「◇ 给我一个提示」入口（点击读库展开，无二次 AI 等待）；
 * - 已释放：提示随会话持久展示（刷新后仍在）；
 * - 该轮无预生成提示（AI 降级/老数据）：不渲染任何入口。
 */
function FollowupHintBlock({
  round,
  pendingAction,
  onRequest,
}: {
  round: FollowupRound;
  pendingAction: PendingAction;
  onRequest: () => void;
}) {
  if (round.hintReleased && round.hint) {
    return (
      <div className="ml-12 rounded-xl border border-[#FDE68A] bg-[#FFFBEB] px-4 py-3 text-xs leading-6 text-[#92400E]">
        <span className="mr-2 rounded border border-[#FDE68A] bg-white px-1.5 py-0.5 text-[10px] font-medium text-[#B45309]">
          提示
        </span>
        {round.hint}
      </div>
    );
  }
  if (round.hasHint) {
    return (
      <div className="ml-12 flex items-center gap-2">
        <button
          type="button"
          onClick={onRequest}
          disabled={pendingAction !== null}
          className="rounded-lg border border-dashed border-[#2563EB]/50 px-3 py-1.5 text-xs font-semibold text-[#2563EB] transition-colors hover:bg-[#EFF5FF] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pendingAction === "followup-hint" ? "释放中…" : "◇ 给我一个提示"}
        </button>
        <span className="text-[11px] text-[#94A3B8]">追问提示 · 系数 −0.05</span>
      </div>
    );
  }
  return null;
}

/** 追问对话气泡（吸收原型 C：总监左气泡、用户右气泡） */
function ChatBubble({ message }: { message: ChatMessage }) {
  const isDirector = message.role === "director";
  return (
    <div className={`flex gap-3 ${isDirector ? "" : "flex-row-reverse"}`}>
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white shadow-[0_2px_5px_rgba(16,24,40,0.15)] ${
          isDirector
            ? "bg-gradient-to-br from-[#3B82F6] to-[#2563EB] text-[10px] font-bold"
            : "bg-gradient-to-br from-[#7C93AB] to-[#5B7189] text-xs"
        }`}
      >
        {isDirector ? "总监" : "我"}
      </div>
      <div className={`flex max-w-[80%] flex-col ${isDirector ? "items-start" : "items-end"}`}>
        <div className="mb-1 flex items-center gap-2 px-1 text-[11px] text-[#94A3B8]">
          {isDirector ? <span className="font-semibold text-[#475569]">产品总监</span> : null}
          {message.isFollowup ? (
            <span className="rounded border border-[#D9E7FD] bg-[#EFF5FF] px-1.5 py-0.5 text-[10px] text-[#2563EB]">
              追问
            </span>
          ) : null}
        </div>
        <div
          className={`px-4 py-3 text-sm leading-7 ${
            isDirector
              ? "rounded-2xl rounded-tl-md border border-[#E9EDF4] bg-white text-[#0F172A] shadow-[0_1px_2px_rgba(16,24,40,0.06)]"
              : "rounded-2xl rounded-tr-md border border-[#D9E7FD] bg-[#EFF5FF] text-[#12233F]"
          }`}
        >
          {message.content}
        </div>
      </div>
    </div>
  );
}

/** 完成阶段：终答已提交，评分与诊断由反馈页（T07）承接；T21 起日常模式附「再练一题」（加练入口） */
function DoneSection({
  sessionId,
  finalAnswer,
  pendingAction,
  onStartExtra,
}: {
  sessionId: string;
  finalAnswer: string | null;
  pendingAction: PendingAction;
  /** null 时隐藏加练入口（基线复用模式） */
  onStartExtra: (() => void) | null;
}) {
  return (
    <section className={`${CARD} p-8 text-center`}>
      <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-[#ECFDF5] text-lg text-[#047857]">
        ✓
      </div>
      <h3 className="text-lg font-bold">本次训练已完成</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#475569]">
        最终答案已提交，评分与诊断生成后将在训练反馈页展示。
      </p>
      {finalAnswer ? (
        <p className="mx-auto mt-4 max-w-lg rounded-xl border border-[#E9EDF4] bg-[#F8FAFD] px-4 py-3 text-left text-xs leading-6 text-[#475569]">
          {finalAnswer}
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-4">
        <Link
          href={`/training/feedback/${sessionId}`}
          className="text-sm font-medium text-[#2563EB] hover:underline"
        >
          查看训练反馈 →
        </Link>
        {onStartExtra ? (
          <button
            type="button"
            onClick={onStartExtra}
            disabled={pendingAction !== null}
            className={PRIMARY_BTN}
          >
            {pendingAction === "extra" ? "创建中…" : "再练一题"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** 已释放提示列表（作答/追问阶段均保留，作为本题记录） */
function ReleasedHintsCard({ payload }: { payload: TodayView }) {
  const hints = payload.releasedHints;
  if (hints.length === 0) return null;
  return (
    <section className={`${CARD} p-6`}>
      <div className="mb-4 flex items-baseline justify-between">
        <h3 className="text-[15px] font-bold">已释放的提示</h3>
        <span className="text-xs text-[#94A3B8]">
          {hints.length}/{MAX_HINT_LAYERS} 层
        </span>
      </div>
      <ol className="flex flex-col gap-3">
        {hints.map((hint) => (
          <li key={hint.level} className="flex gap-3 text-sm leading-6">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#EFF5FF] text-[10px] font-bold text-[#2563EB]">
              {hint.level}
            </span>
            <div>
              <span className="mr-2 rounded border border-[#E9EDF4] bg-[#F5F7FA] px-1.5 py-0.5 text-[10px] text-[#64748B]">
                {hint.stage}
              </span>
              <span className="text-[13px] text-[#475569]">{hint.question}</span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
