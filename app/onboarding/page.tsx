import type { Metadata } from "next";

import { ProfileForm } from "./profile-form";

export const metadata: Metadata = {
  title: "认识一下你 · 训练台",
};

/**
 * 初始用户画像问卷页（US-001 / T04）。
 * 视觉沿用 prototypes/prototype-b-dashboard.html：浅灰底 #F5F6F8、白色卡片、主色 #2563EB。
 */
export default function OnboardingPage() {
  return (
    <div className="min-h-full flex-1 bg-[#F5F6F8] text-[#0F172A]">
      <div className="mx-auto w-full max-w-2xl px-5 py-10">
        <header className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#2563EB] text-lg font-bold text-white">
            训
          </div>
          <div>
            <div className="text-base font-bold">训练台</div>
            <div className="text-xs text-[#94A3B8]">产品经理刻意练习</div>
          </div>
        </header>

        <div className="mb-6">
          <h1 className="text-2xl font-bold">先认识一下你</h1>
          <p className="mt-2 text-sm leading-6 text-[#475569]">
            2~3 分钟完成。你的回答会让第一道题优先来自你熟悉的产品，也让训练更贴近你的方向。
          </p>
        </div>

        <ProfileForm />
      </div>
    </div>
  );
}
