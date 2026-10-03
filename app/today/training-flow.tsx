"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";

import {
  fetchTodaySession,
  requestHint,
  submitFinalAnswer,
  submitFirstAnswer,
} from "./api";
import type { TodayView } from "./contract";
import { TodayShell } from "./shell";
import type { ChatMessage, MaterialView } from "./view-model";
import {
  MAX_HINT_LAYERS,
  THINKING_DIRECTIONS,
  buildFollowupMessages,
  canSubmitAnswer,
  formatCoefficient,
  hintMicrocopy,
  isHintButtonVisible,
  stageLabel,
  stageOfSession,
  toCaseFieldViews,
  toCaseSourceViews,
  toMaterialViews,
} from "./view-model";

/**
 * 今日训练交互主体（P3，T05-Page）。
 * 状态流：作答（可请求提示）→ 首答提交 → 总监追问 → 终答提交 → 完成；
 * 刷新后由 GET /api/training/today 返回的会话状态恢复到对应阶段（R4）。
 * 全部状态→视图判定走 view-model 纯函数，本组件只负责渲染与调用适配层。
 */

const CARD =
  "rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const PRIMARY_BTN =
  "rounded-xl bg-[#2563EB] px-6 py-3 text-sm font-bold text-white shadow-[0_4px_12px_rgba(37,99,235,0.25)] transition-colors hover:bg-[#1D4ED8] disabled:cursor-not-allowed disabled:bg-[#94A3B8] disabled:shadow-none";
const TEXTAREA =
  "w-full resize-y rounded-xl border border-[#E9EDF4] bg-white px-4 py-3 text-sm leading-6 text-[#0F172A] outline-none transition-colors placeholder:text-[#94A3B8] focus:border-[#2563EB]";

type PendingAction = "hint" | "first" | "final" | null;

export function TrainingFlow() {
  const [payload, setPayload] = useState<TodayView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [draft, setDraft] = useState("");
  const [finalDraft, setFinalDraft] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setPayload(await fetchTodaySession());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "加载失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, []);

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
      setPayload((prev) =>
        prev
          ? {
              ...prev,
              state: res.state,
              firstAnswer: res.firstAnswer,
              followups: res.followups,
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

  /** 提交终答：进入评分等待；接口幂等，重复点击不覆盖不重复计分 */
  const onSubmitFinal = useCallback(async () => {
    if (!payload || pendingAction || !canSubmitAnswer(finalDraft)) return;
    setPendingAction("final");
    setActionError(null);
    try {
      const res = await submitFinalAnswer(payload.sessionId, finalDraft.trim());
      setPayload((prev) =>
        prev ? { ...prev, state: res.state, finalAnswer: res.finalAnswer } : prev,
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "提交失败，请重试");
    } finally {
      setPendingAction(null);
    }
  }, [payload, pendingAction, finalDraft]);

  const stage = payload ? stageOfSession(payload.state, payload.finalAnswer) : "answering";
  const stageText = loading && !payload ? "加载中" : stageLabel(stage);

  return (
    <TodayShell stageText={stageText}>
      <div className="mx-auto w-full max-w-6xl">
        {loading && !payload ? <LoadingView /> : null}

        {loadError ? (
          <div className={`${CARD} p-10 text-center`}>
            <p className="text-sm text-[#475569]">{loadError}</p>
            <button type="button" onClick={() => void load()} className={`${PRIMARY_BTN} mt-5`}>
              重新加载
            </button>
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
            <header className="mb-6 flex flex-wrap items-center gap-3">
              <span className="text-xs font-bold tracking-[0.16em] text-[#2563EB]">今日训练</span>
              <span className="rounded-full border border-[#E9EDF4] bg-white px-3 py-1 text-xs text-[#475569]">
                {stageLabel(stage)}
              </span>
              {stage === "answering" ? (
                <span className="text-xs text-[#94A3B8]">
                  作答后，AI 产品总监将追问并给出诊断
                </span>
              ) : null}
            </header>

            <div className="grid items-start gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
              {/* 左栏：案例卡 / 训练重点小卡 / 参考资料 */}
              <div className="flex flex-col gap-5">
                <CaseCard payload={payload} />
                <FocusCard abilityTags={payload.abilityTags} />
                <MaterialsCard materials={toMaterialViews(payload.materials)} />
              </div>

              {/* 右栏：主问题 + 各阶段交互区 */}
              <div className="flex min-w-0 flex-col gap-5">
                <section className={`${CARD} p-7`}>
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
                    finalDraft={finalDraft}
                    pendingAction={pendingAction}
                    onFinalDraftChange={setFinalDraft}
                    onSubmitFinal={() => void onSubmitFinal()}
                  />
                ) : null}

                {stage === "done" ? (
                  <DoneSection sessionId={payload.sessionId} finalAnswer={payload.finalAnswer} />
                ) : null}

                <ReleasedHintsCard payload={payload} />

                {actionError ? (
                  <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                    {actionError}
                  </p>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </TodayShell>
  );
}

/** 加载骨架（评分等待同样克制，R5 骨架屏原则） */
function LoadingView() {
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
      <div className={`${CARD} h-72 animate-pulse bg-[#EDF1F7]`} />
      <div className="flex flex-col gap-5">
        <div className={`${CARD} h-32 animate-pulse bg-[#EDF1F7]`} />
        <div className={`${CARD} h-64 animate-pulse bg-[#EDF1F7]`} />
      </div>
    </div>
  );
}

/** 今日案例卡：五字段事实（字段结尾内联引用链接，T13 / BR-8） */
function CaseCard({ payload }: { payload: TodayView }) {
  const fields = toCaseFieldViews(payload.caseBackground, toCaseSourceViews(payload.caseSources));
  return (
    <section className={`${CARD} p-6`}>
      <span className="mb-3 block text-xs font-bold tracking-[0.16em] text-[#2563EB]">
        今日案例
      </span>
      <h2 className="mb-4 text-base leading-7 font-bold">{payload.caseTitle}</h2>
      <dl className="flex flex-col gap-3">
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

/** 训练重点小卡：今天练什么（能力标签即评分维度，BR-1） */
function FocusCard({ abilityTags }: { abilityTags: string[] }) {
  return (
    <section className="rounded-2xl border border-[#D9E7FD] bg-[#EFF5FF] p-6">
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

/** 参考资料卡：★核心 2 篇在前，○扩展 3 篇在后；阅读不扣分（BR-3） */
function MaterialsCard({ materials }: { materials: MaterialView[] }) {
  return (
    <section className={`${CARD} p-6`}>
      <div className="mb-4 flex items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-bold">参考资料</h3>
        <span className="text-[11px] whitespace-nowrap text-[#94A3B8]">阅读不扣分</span>
      </div>
      <ul className="flex flex-col gap-4">
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
      <h3 className="mb-3 text-[15px] font-bold">我的回答</h3>
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

/** 追问阶段：对话气泡（总监左、用户右）+ 补充输入 + 提交最终答案 */
function FollowupSection({
  payload,
  finalDraft,
  pendingAction,
  onFinalDraftChange,
  onSubmitFinal,
}: {
  payload: TodayView;
  finalDraft: string;
  pendingAction: PendingAction;
  onFinalDraftChange: (value: string) => void;
  onSubmitFinal: () => void;
}) {
  const messages = buildFollowupMessages(payload.firstAnswer, payload.followups);
  const hasDirectorMessage = messages.some((message) => message.role === "director");
  return (
    <>
      <section className={`${CARD} p-7`}>
        <div className="mb-5 flex items-baseline justify-between">
          <h3 className="text-[15px] font-bold">总监追问</h3>
          <span className="text-xs text-[#94A3B8]">追问不扣分，放心补充</span>
        </div>
        <div className="flex flex-col gap-5">
          {messages.map((message, index) => (
            <ChatBubble key={index} message={message} />
          ))}
          {!hasDirectorMessage ? (
            <p className="rounded-xl border border-dashed border-[#C6D3E6] bg-[#F8FAFD] px-4 py-3 text-xs leading-5 text-[#475569]">
              总监暂时离开（追问生成失败），不影响本次训练——可直接提交最终答案。
            </p>
          ) : null}
        </div>
      </section>

      <section className={`${CARD} p-7`}>
        <h3 className="mb-3 text-[15px] font-bold">补充你的判断</h3>
        <textarea
          className={`${TEXTAREA} min-h-32`}
          placeholder="回应追问，修正或深化你的结论……"
          value={finalDraft}
          onChange={(event) => onFinalDraftChange(event.target.value)}
        />
        <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
          <span className="text-xs text-[#94A3B8]">
            本题提示 {payload.hintCount} 次 · 独立完成系数{" "}
            {formatCoefficient(payload.coefficient)}
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
      </section>
    </>
  );
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

/** 完成阶段：终答已提交，评分与诊断由反馈页（T07）承接 */
function DoneSection({
  sessionId,
  finalAnswer,
}: {
  sessionId: string;
  finalAnswer: string | null;
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
      <Link
        href={`/today/feedback/${sessionId}`}
        className="mt-6 inline-block text-sm font-medium text-[#2563EB] hover:underline"
      >
        查看训练反馈 →
      </Link>
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
