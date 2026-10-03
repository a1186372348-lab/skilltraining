"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { fetchAbilityProfile } from "./api";
import type { AbilityDimensionView, AbilityPageView } from "./contract";
import { ProfileShell } from "./shell";
import {
  diagnosisLineOf,
  featureLineOf,
  formatProfileScore,
  gaugeLevelOf,
  isGuideState,
  observationText,
  sparklineGeometry,
  sparklineStroke,
  statusTagClass,
  weakestObservedDimension,
} from "./view-model";

/**
 * 能力画像页交互主体（P2，T09：US-008 / FR-8 / BR-6）。
 * 数据流：进入即 GET /api/profile/ability → 顶部洞察条（n/8 + 下一题优先方向）
 * → 已观测维度行（大号分数/观察次数/趋势火花线/状态标签，最弱维度默认展开
 * 特征与诊断）→ 未观测维度虚线空态卡（不显示 0 分）→ 整体提示依赖度仪表条。
 * 8 维全部未观测时整页降级为「开始第一次训练后生成」引导态（T09 失败与回滚）。
 * 全部数据→视图判定走 view-model 纯函数，本组件只负责渲染与调用适配层。
 */

const CARD =
  "rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const PRIMARY_BTN =
  "inline-flex items-center gap-2 rounded-xl bg-[#2563EB] px-6 py-3 text-sm font-bold text-white shadow-[0_4px_12px_rgba(37,99,235,0.25)] transition-colors hover:bg-[#1D4ED8]";

type Phase = "loading" | "ready" | "error";

export function ProfileFlow() {
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
          setErrorMessage(error instanceof Error ? error.message : "加载失败，请稍后重试");
          setPhase("error");
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [retryToken]);

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

function ProfileContent({ view }: { view: AbilityPageView }) {
  const observed = view.dimensions.filter((d) => d.observed);
  const unobserved = view.dimensions.filter((d) => !d.observed);
  const weakest = useMemo(() => weakestObservedDimension(view.dimensions), [view.dimensions]);
  /** 展开诊断的维度：默认最弱维度（US-008 弱项展开） */
  const [expandedDimension, setExpandedDimension] = useState<string | null>(
    weakest?.dimension ?? null,
  );

  return (
    <div className="flex flex-col gap-5 pb-4">
      {/* 顶部洞察条 */}
      <div className="flex items-center gap-3 rounded-xl border border-[#D9E7FD] border-l-[3px] border-l-[#2563EB] bg-gradient-to-r from-[#EDF4FF] to-[#F7FAFF] px-5 py-3.5 text-[13.5px] text-[#33425E]">
        <span aria-hidden className="text-[#2563EB]">◇</span>
        <span>
          AI 已了解你{" "}
          <b className="font-bold text-[#1D4ED8]">
            {view.insight.observedCount}/{view.insight.totalCount}
          </b>{" "}
          个维度<span className="mx-1.5 text-[#B7C6DC]">·</span>
          {view.insight.nextFocus.text}
        </span>
      </div>

      {isGuideState(view) ? (
        <GuideCard />
      ) : (
        <section className={`${CARD} overflow-hidden`}>
          <div className="flex items-center justify-between border-b border-[#E9EDF4] px-6 py-4">
            <h3 className="text-[15px] font-bold">已观测维度</h3>
            <span className="text-xs text-[#94A3B8]">
              共 {observed.length} 个维度 · 每次训练后更新
            </span>
          </div>
          <ul>
            {observed.map((dim) => (
              <ObservedRow
                key={dim.dimension}
                dim={dim}
                expanded={expandedDimension === dim.dimension}
                isNextFocus={
                  view.insight.nextFocus.mode === "strengthen" &&
                  view.insight.nextFocus.dimension === dim.dimension
                }
                onToggle={() =>
                  setExpandedDimension((prev) =>
                    prev === dim.dimension ? null : dim.dimension,
                  )
                }
              />
            ))}
          </ul>
        </section>
      )}

      {unobserved.length > 0 ? (
        <section>
          <div className="mx-0.5 mb-3 flex flex-wrap items-baseline gap-3">
            <h3 className="text-[15px] font-bold">未观测维度</h3>
            <span className="text-xs text-[#94A3B8]">
              完成更多训练后，AI 将逐步探索这些维度
            </span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {unobserved.map((dim) => (
              <GhostCard key={dim.dimension} dimension={dim.dimension} />
            ))}
          </div>
        </section>
      ) : null}

      {!isGuideState(view) ? (
        <HintDependencyGauge view={view} />
      ) : null}
    </div>
  );
}

/** 已观测维度行：大号分数 + 观察次数 + SVG 趋势火花线 + 状态标签，点击展开/收起诊断 */
function ObservedRow({
  dim,
  expanded,
  isNextFocus,
  onToggle,
}: {
  dim: AbilityDimensionView;
  expanded: boolean;
  isNextFocus: boolean;
  onToggle: () => void;
}) {
  const spark = sparklineGeometry(dim.sparkline);
  const stroke = sparklineStroke(dim.trend);
  const rising = dim.trend === "上升";
  return (
    <li className="border-b border-[#F0F3F8] last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 px-6 py-4 text-left transition-colors hover:bg-[#FAFBFE] sm:grid-cols-[150px_80px_110px_1fr_auto]"
      >
        <span className="text-sm font-semibold text-[#1E293B]">{dim.dimension}</span>
        <span
          className={`justify-self-start text-[23px] leading-none font-bold sm:justify-self-auto ${
            rising ? "text-[#2563EB]" : "text-[#0F172A]"
          }`}
        >
          {dim.currentScore === null ? "-" : formatProfileScore(dim.currentScore)}
        </span>
        <span className="text-xs text-[#64748B]">{observationText(dim.observationCount)}</span>
        <span className="hidden sm:block">
          {spark ? (
            <svg
              viewBox="0 0 120 32"
              width={120}
              height={32}
              fill="none"
              aria-hidden
              className="block"
            >
              <polyline
                points={spark.points}
                stroke={stroke}
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx={spark.end.x} cy={spark.end.y} r={rising ? 2.6 : 2.4} fill={stroke} />
            </svg>
          ) : null}
        </span>
        <span
          className={`justify-self-end rounded-full border px-3 py-1 text-[11.5px] font-semibold whitespace-nowrap ${
            dim.statusLabel ? statusTagClass(dim.statusLabel) : ""
          }`}
        >
          {dim.statusLabel}
        </span>
      </button>
      {expanded ? (
        <div className="mx-6 mb-4 rounded-r-xl border-l-[3px] border-l-[#2563EB] bg-[#F7FAFF] px-5 py-3">
          <p className="text-xs leading-6 text-[#475569]">
            <span className="font-bold text-[#1E293B]">特征</span>：{featureLineOf(dim)}
          </p>
          <p className="text-xs leading-6 text-[#475569]">
            <span className="font-bold text-[#1E293B]">诊断</span>：{diagnosisLineOf(dim)}
            {isNextFocus ? (
              <>
                <span className="px-1 font-semibold text-[#2563EB]">→</span>
                <span className="inline-block rounded-full bg-[#E3EEFF] px-2.5 py-0.5 align-[1px] text-[11.5px] font-semibold text-[#1D4ED8]">
                  已列入下一题训练方向
                </span>
              </>
            ) : null}
          </p>
        </div>
      ) : null}
    </li>
  );
}

/** 未观测维度虚线空态卡（FR-8：不显示 0 分） */
function GhostCard({ dimension }: { dimension: string }) {
  return (
    <div className="rounded-2xl border-[1.5px] border-dashed border-[#CBD5E3] bg-[#FBFCFE] px-5 py-6 text-center transition-colors hover:border-[#AEC2DC] hover:bg-[#F8FBFF]">
      <div className="mx-auto mb-3 flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-[#EFF3F9]">
        <svg
          viewBox="0 0 16 16"
          width={15}
          height={15}
          fill="none"
          stroke="#9AA9BF"
          strokeWidth={1.5}
          strokeLinecap="round"
          aria-hidden
        >
          <rect x="3.5" y="7" width="9" height="6" rx="1.5" />
          <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
        </svg>
      </div>
      <div className="mb-1 text-sm font-semibold text-[#7A8AA3]">{dimension}</div>
      <div className="text-[11.5px] text-[#A6B2C6]">待解锁 · 完成更多训练后开启观测</div>
    </div>
  );
}

/** 整体提示依赖度 5 段仪表条 */
function HintDependencyGauge({ view }: { view: AbilityPageView }) {
  const overall = view.hintDependencyOverall;
  const level = gaugeLevelOf(overall?.band ?? null);
  // 段色随点亮进度加深（原型 B 的渐进蓝）
  const SEG_COLORS = ["#BFDBFE", "#93C5FD", "#60A5FA", "#3B82F6", "#2563EB"];
  return (
    <section className={`${CARD} flex flex-wrap items-center gap-x-8 gap-y-4 px-7 py-5`}>
      <div>
        <h4 className="mb-1 text-[15px] font-bold">整体提示依赖度</h4>
        <p className="text-xs text-[#94A3B8]">提示使用越独立，得分系数越高</p>
      </div>
      <div className="flex flex-col gap-1.5 sm:ml-auto">
        <div className="flex gap-1.5">
          {SEG_COLORS.map((color, index) => (
            <span
              key={color}
              className="h-[9px] w-[46px] rounded-[5px]"
              style={{ backgroundColor: index < level ? color : "#E2E8F0" }}
            />
          ))}
        </div>
        <div className="flex justify-between text-[11px] text-[#94A3B8]">
          <span>低</span>
          <span>中</span>
          <span>高</span>
        </div>
      </div>
      <span className="rounded-xl border border-[#D9E7FD] bg-[#EFF5FF] px-5 py-2.5 text-[17px] font-bold text-[#1D4ED8]">
        {overall ? overall.band : "—"}
      </span>
    </section>
  );
}

/** 整页降级引导态（T09 失败与回滚）：8 维全部未观测时替代已观测区 */
function GuideCard() {
  return (
    <section className={`${CARD} p-10 text-center`}>
      <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-[#EFF5FF] text-[#2563EB]">
        ◇
      </div>
      <h3 className="text-lg font-bold">开始第一次训练后，生成你的能力画像</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#475569]">
        AI 会基于你的每次作答，逐步观测 8 个产品能力维度：分数、趋势、提示依赖特征与针对性诊断。
        未知维度不会被当作 0 分。
      </p>
      <Link href="/today" className={`${PRIMARY_BTN} mt-6`}>
        去今日训练
        <span aria-hidden className="text-xs">▸</span>
      </Link>
    </section>
  );
}
