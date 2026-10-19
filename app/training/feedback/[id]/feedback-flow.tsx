"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { TodayShell } from "../../session/shell";
import { ApiError, startExtraSession } from "../../session/api";

import { fetchFeedback, submitSurvey } from "./api";
import type {
  FeedbackDimensionScore,
  ReadyFeedbackView,
  SurveyStatus,
} from "./contract";
import {
  SCORING_POLL_INTERVAL_MS,
  calculationDetailLines,
  canSubmitSurvey,
  feedbackStageText,
  formatScore,
  scoreBreakdownText,
  shouldShowPollError,
  visibleSurveyQuestions,
  type SurveyAnswers,
  type SurveyQuestion,
} from "./view-model";

/**
 * 训练反馈页交互主体（P4，T07：US-007 / FR-7，产品的"情感峰值页"）。
 * 数据流：进入即 GET feedback（懒触发评分）→ scoring 时显示"总监评分中"
 * 等待态并按间隔轮询（真实延迟 35~49 秒）→ ready 后渲染三条有效得分行、
 * 「最需要优化的一个问题」强调卡、「下一步」卡、星级问卷与双按钮。
 * 全部数据→视图判定走 view-model 纯函数，本组件只负责渲染与调用适配层。
 * 问卷提交失败不影响已生成的反馈内容展示（T07 失败与回滚约定）。
 */

const CARD =
  "rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const PRIMARY_BTN =
  "rounded-xl bg-[#2563EB] px-6 py-3 text-sm font-bold text-white shadow-[0_4px_12px_rgba(37,99,235,0.25)] transition-colors hover:bg-[#1D4ED8] disabled:cursor-not-allowed disabled:bg-[#94A3B8] disabled:shadow-none";
const SECONDARY_BTN =
  "rounded-xl border border-[#2563EB] bg-white px-6 py-3 text-sm font-bold text-[#2563EB] transition-colors hover:bg-[#EFF5FF]";

type Phase = "loading" | "scoring" | "ready" | "error";

export function FeedbackFlow({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [view, setView] = useState<ReadyFeedbackView | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** 手动重试令牌：递增触发 effect 重新进入轮询（避免 ref 存储轮询状态） */
  const [retryToken, setRetryToken] = useState(0);
  /** 再练一题（T21）：创建/复用加练会话中；失败在按钮旁行内提示 */
  const [extraPending, setExtraPending] = useState(false);
  const [extraError, setExtraError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** 拉取反馈视图：scoring 继续轮询；ready 落地渲染；连续失败按阈值降级 */
    async function poll(failures: number): Promise<void> {
      try {
        const result = await fetchFeedback(sessionId);
        if (cancelled) return;
        if (result.status === "scoring") {
          setPhase("scoring");
          timer = setTimeout(() => void poll(0), SCORING_POLL_INTERVAL_MS);
          return;
        }
        setView(result);
        setPhase("ready");
      } catch (error) {
        if (cancelled) return;
        const next = failures + 1;
        if (shouldShowPollError(next)) {
          setPhase("error");
          setErrorMessage(error instanceof Error ? error.message : "加载失败，请稍后重试");
          return;
        }
        timer = setTimeout(() => void poll(next), SCORING_POLL_INTERVAL_MS);
      }
    }

    // 首屏加载延迟到 effect 同步阶段之后执行，避免同步 setState 引发级联渲染
    timer = setTimeout(() => void poll(0), 0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, retryToken]);

  /** 手动重试（错误态）：重置失败计数（poll 从 0 起）并重新进入轮询 */
  const onRetry = useCallback(() => {
    setErrorMessage(null);
    setPhase("loading");
    setRetryToken((prev) => prev + 1);
  }, []);

  /** 再练一题（T21 / D3；T25：拿 sessionId 直达新加练会话的工作台） */
  const onStartExtra = useCallback(async () => {
    if (extraPending) return;
    setExtraPending(true);
    setExtraError(null);
    try {
      const res = await startExtraSession();
      router.push(`/training/session/${res.sessionId}`);
    } catch (error) {
      // T36 / D38：基线未完成 → 挡回基线测评（服务端 409 BASELINE_REQUIRED）
      if (error instanceof ApiError && error.code === "BASELINE_REQUIRED") {
        router.push("/baseline");
        return;
      }
      setExtraError(error instanceof Error ? error.message : "创建加练失败，请重试");
    } finally {
      setExtraPending(false);
    }
  }, [extraPending, router]);

  const stageText =
    phase === "ready" && view
      ? feedbackStageText(view)
      : phase === "scoring"
        ? "评分中"
        : phase === "loading"
          ? "加载中"
          : "加载失败";

  return (
    <TodayShell stageText={stageText}>
      <div className="mx-auto w-full max-w-4xl">
        <header className="mb-6 flex flex-wrap items-center gap-3">
          <span className="text-xs font-bold tracking-[0.16em] text-[#2563EB]">训练反馈</span>
          <span className="rounded-full border border-[#E9EDF4] bg-white px-3 py-1 text-xs text-[#475569]">
            {stageText}
          </span>
        </header>

        {phase === "loading" ? <LoadingCard /> : null}
        {phase === "scoring" ? <ScoringCard /> : null}

        {phase === "error" ? (
          <div className={`${CARD} p-10 text-center`}>
            <p className="text-sm text-[#475569]">{errorMessage}</p>
            <button type="button" onClick={onRetry} className={`${PRIMARY_BTN} mt-5`}>
              重新加载
            </button>
          </div>
        ) : null}

        {phase === "ready" && view ? (
          <div className="flex flex-col gap-5">
            <ScoresCard scores={view.scores} />
            <TopIssueCard text={view.topIssueText} />
            <NextStepCard text={view.nextFocusText} />
            <SurveyCard sessionId={view.sessionId} status={view.survey} />
            <div className="flex flex-wrap items-center gap-4 pb-4">
              <Link href="/profile" className={SECONDARY_BTN}>
                查看能力画像
              </Link>
              {view.questionKind === "baseline" ? (
                // T36 / D38：基线题反馈页不出日常加练入口——主按钮回到基线流程
                //（/baseline 自行路由：未完成继续下一题，全部作答待评分进收尾页）
                <Link href="/baseline" className={PRIMARY_BTN}>
                  回到基线测评
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => void onStartExtra()}
                  disabled={extraPending}
                  className={PRIMARY_BTN}
                >
                  {extraPending ? "创建中…" : "再练一题"}
                </button>
              )}
              {extraError ? (
                <span className="text-xs text-red-600">{extraError}</span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </TodayShell>
  );
}

/** 首屏加载占位 */
function LoadingCard() {
  return (
    <div className={`${CARD} animate-pulse p-10 text-center text-sm text-[#94A3B8]`}>
      正在加载本次训练反馈…
    </div>
  );
}

/** 评分等待态：真实评分 35~49 秒，骨架行 + 说明文案，页面自动轮询刷新 */
function ScoringCard() {
  return (
    <div className={`${CARD} p-10`}>
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-[#EFF5FF]">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#2563EB] border-t-transparent" />
        </div>
        <h3 className="text-lg font-bold">总监评分中…</h3>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#475569]">
          产品总监正在按评分细则逐维度评阅你的作答，通常需要 30~60 秒。
          页面会自动刷新，无需操作。
        </p>
      </div>
      <div className="mx-auto mt-8 flex max-w-lg flex-col gap-4">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex animate-pulse items-center gap-4">
            <div className="h-4 w-20 rounded bg-[#E9EDF4]" />
            <div className="h-7 w-12 rounded bg-[#E9EDF4]" />
            <div className="h-3 flex-1 rounded bg-[#EEF1F6]" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** 三条有效得分行：维度名 + 大号分数 + 小字 + 「查看计算过程」展开 */
function ScoresCard({ scores }: { scores: FeedbackDimensionScore[] }) {
  return (
    <section className={`${CARD} p-7`}>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[15px] font-bold">本次有效得分</h3>
        <span className="text-xs text-[#94A3B8]">有效得分 = 原始分 × 独立完成系数</span>
      </div>
      <ul>
        {scores.map((score) => (
          <ScoreRow key={score.dimension} score={score} />
        ))}
      </ul>
    </section>
  );
}

function ScoreRow({ score }: { score: FeedbackDimensionScore }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="border-b border-[#EEF1F6] py-5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="w-24 shrink-0 text-sm font-semibold text-[#0F172A]">
          {score.dimension}
        </span>
        <span className="text-3xl leading-none font-bold text-[#2563EB]">
          {formatScore(score.effectiveScore)}
        </span>
        <span className="min-w-0 flex-1 text-xs text-[#64748B]">
          {scoreBreakdownText(score)}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          className="shrink-0 text-xs font-medium text-[#2563EB] hover:underline"
        >
          {expanded ? "收起计算过程" : "查看计算过程"}
        </button>
      </div>
      {expanded ? (
        <div className="mt-3 rounded-xl bg-[#F8FAFD] px-4 py-3 text-xs leading-6 text-[#475569]">
          {calculationDetailLines(score).map((line) => (
            <p key={line}>{line}</p>
          ))}
          {score.diagnosisText ? (
            <p className="mt-2 border-t border-[#E9EDF4] pt-2">诊断：{score.diagnosisText}</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** 「最需要优化的一个问题」强调卡：左侧竖色条 + 浅底（原型 B 设计语言） */
function TopIssueCard({ text }: { text: string }) {
  return (
    <section className="rounded-2xl border border-[#D9E7FD] border-l-[3px] border-l-[#2563EB] bg-[#F7FAFF] p-7">
      <span className="text-[11px] font-bold tracking-[0.14em] text-[#2563EB]">
        最需要优化的一个问题
      </span>
      <p className="mt-3 text-[15px] leading-7 font-semibold text-[#12233F]">{text}</p>
    </section>
  );
}

/** 「下一步」卡：训练方向 + 理由（与最需优化问题同源，BR-7 可行动闭环） */
function NextStepCard({ text }: { text: string }) {
  return (
    <section className={`${CARD} p-7`}>
      <span className="text-[11px] font-bold tracking-[0.14em] text-[#7C8AA5]">下一步</span>
      <p className="mt-3 text-[15px] leading-7 font-semibold text-[#12233F]">{text}</p>
      <p className="mt-3 text-xs leading-5 text-[#94A3B8]">
        理由：总监依据本次作答诊断给出，与上面「最需要优化的问题」同源，下一题将优先覆盖该方向。
      </p>
    </section>
  );
}

/** 星级问卷卡：两行 1~5 星（触发时三行），提交失败不影响上方反馈内容 */
function SurveyCard({ sessionId, status }: { sessionId: string; status: SurveyStatus }) {
  const [answers, setAnswers] = useState<SurveyAnswers>({
    q1Clarity: null,
    q2Next: null,
    periodicQ3: null,
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(status.submitted);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const questions = visibleSurveyQuestions(status.needsPeriodicQ3);

  const onSubmit = useCallback(async () => {
    if (submitting || !canSubmitSurvey(answers, status.needsPeriodicQ3)) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitSurvey({
        sessionId,
        // 提交前已经 canSubmitSurvey 校验，此处一定有值
        q1Clarity: answers.q1Clarity ?? 0,
        q2Next: answers.q2Next ?? 0,
        periodicQ3: status.needsPeriodicQ3 ? (answers.periodicQ3 ?? undefined) : undefined,
      });
      setSubmitted(true);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "提交失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }, [answers, sessionId, status.needsPeriodicQ3, submitting]);

  if (submitted) {
    return (
      <section className={`${CARD} p-7 text-center`}>
        <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-[#ECFDF5] text-sm text-[#047857]">
          ✓
        </div>
        <p className="text-sm font-semibold text-[#0F172A]">已收到你的反馈</p>
        <p className="mt-1 text-xs text-[#94A3B8]">
          你的评价会让后续训练更贴近你的需要。
        </p>
      </section>
    );
  }

  return (
    <section className={`${CARD} p-7`}>
      <h3 className="mb-2 text-[15px] font-bold">这次训练对你有帮助吗？</h3>
      <div className="divide-y divide-[#EEF1F6]">
        {questions.map((question) => (
          <StarRow
            key={question.key}
            question={question}
            value={answers[question.key]}
            disabled={submitting}
            onSelect={(value) =>
              setAnswers((prev) => ({ ...prev, [question.key]: value }))
            }
          />
        ))}
      </div>
      {submitError ? (
        <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-600">
          {submitError}（反馈内容不受影响，可直接重试）
        </p>
      ) : null}
      <div className="mt-5 flex justify-end">
        <button
          type="button"
          onClick={() => void onSubmit()}
          disabled={!canSubmitSurvey(answers, status.needsPeriodicQ3) || submitting}
          className={PRIMARY_BTN}
        >
          {submitting ? "提交中…" : "提交反馈"}
        </button>
      </div>
    </section>
  );
}

/** 单行星评：题文 + 5 颗可点击星（点亮态主色） */
function StarRow({
  question,
  value,
  disabled,
  onSelect,
}: {
  question: SurveyQuestion;
  value: number | null;
  disabled: boolean;
  onSelect: (value: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3.5">
      <span className="text-sm text-[#0F172A]">{question.text}</span>
      <div className="flex gap-1" role="radiogroup" aria-label={question.text}>
        {[1, 2, 3, 4, 5].map((star) => {
          const lit = value !== null && star <= value;
          return (
            <button
              key={star}
              type="button"
              role="radio"
              aria-checked={lit}
              aria-label={`${star} 星`}
              disabled={disabled}
              onClick={() => onSelect(star)}
              className={`px-0.5 text-2xl leading-none transition-colors disabled:cursor-not-allowed ${
                lit ? "text-[#2563EB]" : "text-[#CBD5E1] hover:text-[#7FA8F5]"
              }`}
            >
              {lit ? "★" : "☆"}
            </button>
          );
        })}
      </div>
    </div>
  );
}
