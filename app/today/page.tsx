import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "今日训练 · 训练台",
};

/**
 * 今日训练占位页。
 * 完整训练闭环（案例 → 回答 → 提示 → 追问 → 评分）由 T05 实现；
 * 当前仅承接画像提交后的跳转（US-001：提交后直接进入首次训练）。
 */
export default function TodayPage() {
  return (
    <div className="min-h-full flex-1 bg-[#F5F6F8] text-[#0F172A]">
      <div className="mx-auto flex w-full max-w-2xl flex-col px-5 py-10">
        <header className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#2563EB] text-lg font-bold text-white">
            训
          </div>
          <div>
            <div className="text-base font-bold">训练台</div>
            <div className="text-xs text-[#94A3B8]">产品经理刻意练习</div>
          </div>
        </header>

        <section className="rounded-2xl border border-[#E9EDF4] bg-white p-8 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <span className="inline-block rounded-full border border-[#D9E7FD] bg-[#EFF5FF] px-3 py-1 text-xs font-medium text-[#2563EB]">
            画像已完成
          </span>
          <h1 className="mt-4 text-2xl font-bold">今日训练</h1>
          <p className="mt-3 text-sm leading-6 text-[#475569]">
            你的初始画像已保存。今日训练模块将在 T05
            交付：第一道题的案例会优先来自你熟悉的产品（D11），随后进入「阅读
            → 作答 → 追问 → 评分」的完整训练闭环。
          </p>
          <div className="mt-6">
            <Link
              href="/onboarding"
              className="text-sm font-medium text-[#2563EB] hover:underline"
            >
              返回修改画像 →
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
