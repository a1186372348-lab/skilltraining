"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";

import {
  formatScore,
  scoreBreakdownText,
} from "../../feedback/[id]/view-model";
import { fetchHistoryDetail } from "../api";
import type { HistoryDetailView, HistoryMissingSection } from "../contract";
import { HistoryShell } from "../shell";
import { formatHistoryDate, sessionStateText } from "../view-model";

import {
  MISSING_BADGE_TEXT,
  answerTimeText,
  caseBackgroundRows,
  coefficientCaption,
  formatDateTime,
  hintEventLine,
  hintSummaryText,
  isSectionMissing,
} from "./view-model";

/**
 * 训练历史详情回放页交互主体（P5 / T10：US-009 / FR-9；T25 / D27 迁入产品训练模块）。
 * 分区顺序按任务契约：案例 → 我的两版答案 → 提示 → 追问 → 评分 → 反馈。
 * 单条记录数据缺失时渲染「记录缺失」徽标与占位，而非整页报错；
 * 记录不存在 / 无权查看（404）时展示错误态并提供返回大厅入口。
 * 全部数据→视图判定走 view-model 纯函数，本组件只负责渲染与调用适配层。
 */

const CARD =
  "rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const PRIMARY_BTN =
  "rounded-xl bg-[#2563EB] px-6 py-3 text-sm font-bold text-white shadow-[0_4px_12px_rgba(37,99,235,0.25)] transition-colors hover:bg-[#1D4ED8]";
const SECTION_LABEL = "text-[11px] font-bold tracking-[0.14em] text-[#7C8AA5]";

type Phase = "loading" | "ready" | "error";

export function HistoryDetailFlow({ sessionId }: { sessionId: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [view, setView] = useState<HistoryDetailView | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    /** 拉取详情回放；404 / 网络失败进入错误态（可手动重试） */
    async function load(): Promise<void> {
      try {
        const result = await fetchHistoryDetail(sessionId);
        if (cancelled) return;
        setView(result);
        setPhase("ready");
      } catch (error) {
        if (cancelled) return;
        setPhase("error");
        setErrorMessage(error instanceof Error ? error.message : "加载失败，请稍后重试");
      }
    }
    const timer = setTimeout(() => void load(), 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, retryToken]);

  const onRetry = useCallback(() => {
    setErrorMessage(null);
    setPhase("loading");
    setRetryToken((prev) => prev + 1);
  }, []);

  return (
    <HistoryShell countText="历史回放">
      <div className="mx-auto w-full max-w-4xl">
        <header className="mb-6 flex flex-wrap items-center gap-3">
          <Link href="/training" className="text-xs font-bold tracking-[0.16em] text-[#2563EB] hover:underline">
            ← 训练历史
          </Link>
          {view ? (
            <span className="rounded-full border border-[#E9EDF4] bg-white px-3 py-1 text-xs text-[#475569]">
              {formatHistoryDate(view.date)} · {sessionStateText(view.state)}
              {view.isExtra ? " · 加练" : ""}
            </span>
          ) : null}
        </header>

        {phase === "loading" ? (
          <div className={`${CARD} animate-pulse p-10 text-center text-sm text-[#94A3B8]`}>
            正在加载本次训练回放…
          </div>
        ) : null}

        {phase === "error" ? (
          <div className={`${CARD} p-10 text-center`}>
            <p className="text-sm text-[#475569]">{errorMessage}</p>
            <div className="mt-5 flex justify-center gap-3">
              <button type="button" onClick={onRetry} className={PRIMARY_BTN}>
                重新加载
              </button>
              <Link
                href="/training"
                className="rounded-xl border border-[#2563EB] bg-white px-6 py-3 text-sm font-bold text-[#2563EB] transition-colors hover:bg-[#EFF5FF]"
              >
                返回列表
              </Link>
            </div>
          </div>
        ) : null}

        {phase === "ready" && view ? (
          <div className="flex flex-col gap-5 pb-6">
            <CaseSection view={view} />
            <AnswersSection view={view} />
            <HintsSection view={view} />
            <FollowupsSection view={view} />
            <ScoresSection view={view} />
            <FeedbackSection view={view} />
          </div>
        ) : null}
      </div>
    </HistoryShell>
  );
}

/** 缺失徽标：分区数据按流程应存在但落库缺失时展示（任务契约：标记而非报错） */
function MissingBadge() {
  return (
    <span className="rounded-full border border-dashed border-[#D8E0EC] px-2.5 py-0.5 text-xs text-[#94A3B8]">
      {MISSING_BADGE_TEXT}
    </span>
  );
}

function missingOf(view: HistoryDetailView, section: HistoryMissingSection): boolean {
  return isSectionMissing(view.missing, section);
}

/** ① 案例区：案例名 / 主问题 / 训练重点 / 案例背景要点（字段结尾内联引用链接，T13 / BR-8） */
function CaseSection({ view }: { view: HistoryDetailView }) {
  const rows = caseBackgroundRows(view.caseBackground);
  return (
    <section className={`${CARD} p-7`}>
      <span className={SECTION_LABEL}>案例</span>
      <h2 className="mt-2 text-xl leading-8 font-bold text-[#0F172A]">{view.caseTitle}</h2>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {view.abilityTags.map((tag) => (
          <span
            key={tag}
            className="rounded-full border border-[#D9E7FD] bg-[#F7FAFF] px-2.5 py-0.5 text-xs text-[#2563EB]"
          >
            {tag}
          </span>
        ))}
        <span className="rounded-full bg-[#F5F6F8] px-2.5 py-0.5 text-xs text-[#64748B]">
          难度 {view.difficulty}/5
        </span>
      </div>
      <div className="mt-4 rounded-xl bg-[#F8FAFD] px-4 py-3">
        <p className="text-[15px] leading-7 font-semibold text-[#12233F]">{view.mainQuestion}</p>
      </div>
      {rows.length > 0 ? (
        <dl className="mt-4 flex flex-col gap-2.5">
          {rows.map((row) => (
            <div key={row.label} className="flex gap-3 text-sm leading-6">
              <dt className="w-16 shrink-0 font-semibold text-[#64748B]">{row.label}</dt>
              <dd className="min-w-0 flex-1 text-[#0F172A]">
                {row.value}
                {row.citations.map((link) => (
                  <Fragment key={link.label}>
                    {" "}
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      title={link.title}
                      className="text-xs font-medium text-[#2563EB] hover:underline"
                    >
                      {link.label}
                    </a>
                  </Fragment>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

/** ② 我的两版答案：首答 / 终答（含提交时间；未提交或缺失给占位） */
function AnswersSection({ view }: { view: HistoryDetailView }) {
  return (
    <section className={`${CARD} p-7`}>
      <span className={SECTION_LABEL}>我的两版答案</span>
      <AnswerBlock
        title="首次作答"
        answer={view.firstAnswer}
        timeText={answerTimeText(view.firstSubmittedAt)}
        missing={missingOf(view, "firstAnswer")}
      />
      <AnswerBlock
        title="最终作答（追问后）"
        answer={view.finalAnswer}
        timeText={answerTimeText(view.finalSubmittedAt)}
        missing={missingOf(view, "finalAnswer")}
      />
    </section>
  );
}

function AnswerBlock({
  title,
  answer,
  timeText,
  missing,
}: {
  title: string;
  answer: string | null;
  timeText: string;
  missing: boolean;
}) {
  return (
    <div className="mt-4 border-b border-[#EEF1F6] pb-4 last:border-b-0 last:pb-0">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-bold text-[#0F172A]">{title}</h3>
        {missing ? <MissingBadge /> : null}
        <span className="ml-auto text-xs text-[#94A3B8]">{timeText}</span>
      </div>
      {answer ? (
        <p className="mt-2 text-sm leading-7 whitespace-pre-wrap text-[#334155]">{answer}</p>
      ) : (
        <p className="mt-2 rounded-xl border border-dashed border-[#D8E0EC] px-4 py-3 text-xs text-[#94A3B8]">
          {missing ? "该部分记录缺失" : "未提交"}
        </p>
      )}
    </div>
  );
}

/** ③ 提示使用：用量摘要 + 系数说明 + 逐层事件（层数 + 时间） */
function HintsSection({ view }: { view: HistoryDetailView }) {
  return (
    <section className={`${CARD} p-7`}>
      <span className={SECTION_LABEL}>提示使用</span>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-[#0F172A]">{hintSummaryText(view.hintCount)}</span>
        <span className="rounded-full bg-[#EFF5FF] px-2.5 py-0.5 font-semibold text-[#2563EB]">
          {coefficientCaption(view.hintCount)}
        </span>
      </div>
      {view.hintEvents.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {view.hintEvents.map((event) => (
            <li
              key={event.layer}
              className="flex items-center gap-3 rounded-xl bg-[#F8FAFD] px-4 py-2.5 text-xs text-[#475569]"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#2563EB]/10 font-bold text-[#2563EB]">
                {event.layer}
              </span>
              {hintEventLine(event)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** ④ 追问对话记录：AI 总监对话气泡（吸收原型 C 呈现，BR-4） */
function FollowupsSection({ view }: { view: HistoryDetailView }) {
  return (
    <section className={`${CARD} p-7`}>
      <span className={SECTION_LABEL}>总监追问</span>
      {view.followups.length === 0 ? (
        <p className="mt-3 text-xs text-[#94A3B8]">本次未产生追问记录</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {view.followups.map((round) => (
            <li key={round.round} className="flex items-start gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#3B82F6] to-[#2563EB] text-xs font-bold text-white">
                总
              </span>
              <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm bg-[#F0F5FF] px-4 py-3">
                <div className="text-[11px] font-semibold text-[#2563EB]">第 {round.round} 轮追问</div>
                <p className="mt-1 text-sm leading-6 text-[#12233F]">{round.question}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** ⑤ 评分：各维度四元组（有效分大号 + 原始分×系数小字 + 诊断） */
function ScoresSection({ view }: { view: HistoryDetailView }) {
  const missing = missingOf(view, "scores");
  return (
    <section className={`${CARD} p-7`}>
      <div className="flex items-center gap-2">
        <span className={SECTION_LABEL}>评分</span>
        {missing ? <MissingBadge /> : null}
      </div>
      {view.scores.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-[#D8E0EC] px-4 py-3 text-xs text-[#94A3B8]">
          {missing ? "评分记录缺失" : "本次训练尚未评分"}
        </p>
      ) : (
        <>
          <ul>
            {view.scores.map((score) => (
              <li key={score.dimension} className="border-b border-[#EEF1F6] py-4 last:border-b-0">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
                  <span className="w-24 shrink-0 text-sm font-semibold text-[#0F172A]">
                    {score.dimension}
                  </span>
                  <span className="text-2xl leading-none font-bold text-[#2563EB]">
                    {formatScore(score.effectiveScore)}
                  </span>
                  <span className="min-w-0 flex-1 text-xs text-[#64748B]">
                    {scoreBreakdownText(score)}
                  </span>
                </div>
                {score.diagnosisText ? (
                  <p className="mt-2 rounded-xl bg-[#F8FAFD] px-4 py-2.5 text-xs leading-6 text-[#475569]">
                    诊断：{score.diagnosisText}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-[#94A3B8]">
            以上有效分已计入对应维度的能力画像（BR-6）。
          </p>
        </>
      )}
    </section>
  );
}

/** ⑥ 反馈：最需优化问题强调卡 + 下一步卡（BR-7） */
function FeedbackSection({ view }: { view: HistoryDetailView }) {
  const missing = missingOf(view, "feedback");
  return (
    <section className="flex flex-col gap-5">
      {view.feedback ? (
        <>
          <div className="rounded-2xl border border-[#D9E7FD] border-l-[3px] border-l-[#2563EB] bg-[#F7FAFF] p-7">
            <span className="text-[11px] font-bold tracking-[0.14em] text-[#2563EB]">
              最需要优化的一个问题
            </span>
            <p className="mt-3 text-[15px] leading-7 font-semibold text-[#12233F]">
              {view.feedback.topIssueText}
            </p>
          </div>
          <div className={`${CARD} p-7`}>
            <span className={SECTION_LABEL}>下一步</span>
            <p className="mt-3 text-[15px] leading-7 font-semibold text-[#12233F]">
              {view.feedback.nextFocusText}
            </p>
          </div>
        </>
      ) : (
        <div className={`${CARD} p-7`}>
          <div className="flex items-center gap-2">
            <span className={SECTION_LABEL}>反馈</span>
            {missing ? <MissingBadge /> : null}
          </div>
          <p className="mt-3 rounded-xl border border-dashed border-[#D8E0EC] px-4 py-3 text-xs text-[#94A3B8]">
            {missing ? "反馈记录缺失" : "本次训练尚未生成反馈"}
          </p>
        </div>
      )}
      <p className="pb-2 text-center text-xs text-[#94A3B8]">
        回放时间：{formatDateTime(view.finalSubmittedAt ?? view.firstSubmittedAt)}
      </p>
    </section>
  );
}
