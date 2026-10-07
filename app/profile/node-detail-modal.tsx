"use client";

import Link from "next/link";

import type { AbilityDimensionView, NextFocus } from "./contract";
import {
  diagnosisLineOf,
  featureLineOf,
  formatProfileScore,
  observationText,
  sparklineGeometry,
  sparklineStroke,
} from "./view-model";

/**
 * 网络图节点详情弹窗（T16 / D20；T18 / D21 评估依据 → 最近评估记录）：
 * 点击 3D 节点后展示四要素——
 * ① 最近评估记录（时间倒序列表：日期 + 有效分 + 案例标题 + 跳转反馈页）；
 * ② 观察次数与趋势（次数 + 状态标签 + 迷你走势）；
 * ③ 提示依赖特征（BR-6 同分不同病）；
 * ④ 下一步训练方向（命中 nextFocus 时标注）。
 * 未观测维度显示未知态，不显示 0 分（FR-8）。
 */

/** 评分日期：ISO 字符串 → 本地化日期；非法值原样占位 */
function evaluationDateText(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString("zh-CN");
}

const SECTION_TITLE = "mb-1 text-xs font-bold text-[#1E293B]";
const SECTION_BODY = "text-xs leading-6 text-[#475569]";

export function NodeDetailModal({
  dim,
  nextFocus,
  onClose,
}: {
  dim: AbilityDimensionView;
  nextFocus: NextFocus;
  onClose: () => void;
}) {
  const spark = sparklineGeometry(dim.recentScores);
  const isNextFocus = nextFocus.dimension === dim.dimension;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${dim.dimension} 评估详情`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#0F172A]/45 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-[0_16px_48px_rgba(15,23,42,0.25)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <h3 className="text-base font-bold text-[#0F172A]">{dim.dimension}</h3>
            {dim.observed && dim.currentScore !== null ? (
              <span className="text-[22px] leading-none font-bold text-[#1D4ED8]">
                {formatProfileScore(dim.currentScore)}
              </span>
            ) : (
              <span className="rounded-full bg-[#F1F5F9] px-2.5 py-0.5 text-[11.5px] font-semibold text-[#64748B]">
                未观测
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-lg px-2 py-1 text-sm text-[#94A3B8] transition-colors hover:bg-[#F1F5F9] hover:text-[#475569]"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-4">
          {/* ① 最近评估记录：时间倒序列表，可跳转对应训练反馈页（T18 / D21） */}
          <section>
            <h4 className={SECTION_TITLE}>最近评估记录</h4>
            {dim.recentEvaluations.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {dim.recentEvaluations.map((evaluation) => (
                  <li
                    key={evaluation.sessionId}
                    className="flex items-center gap-2.5 rounded-xl bg-[#F8FAFC] px-3 py-2"
                  >
                    <span className="shrink-0 text-[11px] text-[#94A3B8]">
                      {evaluationDateText(evaluation.scoredAt)}
                    </span>
                    <span className="shrink-0 text-xs font-bold text-[#1D4ED8]">
                      {Math.round(evaluation.score)} 分
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate text-xs text-[#475569]"
                      title={evaluation.caseTitle}
                    >
                      {evaluation.caseTitle}
                    </span>
                    <Link
                      href={`/training/feedback/${evaluation.sessionId}`}
                      className="shrink-0 text-[11px] font-semibold text-[#1D4ED8] hover:underline"
                    >
                      查看评估 →
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={SECTION_BODY}>
                {dim.observed
                  ? "暂无评估记录，完成更多训练后生成"
                  : "该维度尚未观测，完成相关训练后生成评估记录"}
              </p>
            )}
          </section>

          {/* ② 观察次数与趋势：次数 + 状态标签 + 迷你走势 */}
          <section>
            <h4 className={SECTION_TITLE}>观察次数与趋势</h4>
            <div className="flex items-center gap-3">
              <span className={SECTION_BODY}>{observationText(dim.observationCount)}</span>
              {dim.statusLabel ? (
                <span className="rounded-full border border-[#E6EAF1] bg-[#F8FAFC] px-2 py-0.5 text-[11px] font-semibold text-[#64748B]">
                  {dim.statusLabel}
                </span>
              ) : null}
              {spark ? (
                <svg viewBox="0 0 120 32" width={96} height={26} fill="none" aria-hidden>
                  <polyline
                    points={spark.points}
                    stroke={sparklineStroke(dim.trend)}
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle cx={spark.end.x} cy={spark.end.y} r={2.4} fill={sparklineStroke(dim.trend)} />
                </svg>
              ) : (
                <span className={SECTION_BODY}>暂无走势</span>
              )}
            </div>
          </section>

          {/* ③ 提示依赖特征（BR-6 同分不同病） */}
          <section>
            <h4 className={SECTION_TITLE}>提示依赖特征</h4>
            <p className={SECTION_BODY}>{featureLineOf(dim)}</p>
          </section>

          {/* ④ 下一步训练方向 */}
          <section>
            <h4 className={SECTION_TITLE}>下一步训练方向</h4>
            <p className={SECTION_BODY}>
              {diagnosisLineOf(dim)}
              {isNextFocus ? (
                <span className="ml-2 inline-block rounded-full bg-[#E3EEFF] px-2.5 py-0.5 align-[1px] text-[11.5px] font-semibold text-[#1D4ED8]">
                  已列入下一题训练方向
                </span>
              ) : null}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
