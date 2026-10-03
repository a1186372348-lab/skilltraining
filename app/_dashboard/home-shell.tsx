import Link from "next/link";
import type { ReactNode } from "react";

/**
 * 首页外壳：深色侧边栏 + 主区浅灰底（原型 B 设计语言）。
 * 复制自 app/today/shell.tsx 微调（当前页高亮「首页」，侧栏底部加「连续训练」行）；
 * 【主代理后续动作】多页外壳稳定后抽共享组件。
 * 路由依据 Prd.md 3.2 蓝图：/ 首页、/today 今日训练、/profile 能力画像、
 * /history 训练历史、/settings 我的；未交付页面仅作导航占位。
 */

const NAV_ITEMS = [
  { label: "首页", href: "/", active: true },
  { label: "今日训练", href: "/today", active: false },
  { label: "能力画像", href: "/profile", active: false },
  { label: "训练历史", href: "/history", active: false },
  { label: "我的", href: "/settings", active: false },
] as const;

export function HomeShell({
  stageText,
  streakDays,
  children,
}: {
  /** 侧栏底部的今日状态（如 待开始 / 作答中 / 已完成） */
  stageText: string;
  /** 侧栏底部的连续训练天数 */
  streakDays: number;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-1 bg-[#F5F6F8] text-[#0F172A]">
      {/* 深色侧边栏（桌面优先，D4；窄屏隐藏） */}
      <aside className="hidden w-60 shrink-0 flex-col bg-gradient-to-b from-[#101A2E] to-[#0B1322] px-5 py-7 text-[#C4CDDD] lg:flex">
        <div className="mb-6 flex items-center gap-3 border-b border-white/10 px-2 pb-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#3B82F6] to-[#2563EB] text-base font-bold text-white shadow-[0_6px_14px_-4px_rgba(37,99,235,0.55)]">
            训
          </div>
          <div>
            <div className="text-base font-bold tracking-wide text-white">训练台</div>
            <div className="text-[11px] text-[#66738C]">产品经理刻意练习</div>
          </div>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) =>
            item.active ? (
              <span
                key={item.label}
                className="relative rounded-xl bg-[#2563EB]/20 px-4 py-3 text-sm font-semibold text-white"
              >
                <span className="absolute top-2.5 bottom-2.5 -left-5 w-[3px] rounded-r bg-[#3B82F6]" />
                {item.label}
              </span>
            ) : (
              <Link
                key={item.label}
                href={item.href}
                className="rounded-xl px-4 py-3 text-sm text-[#8B98B2] transition-colors hover:bg-white/5 hover:text-[#E9EEF7]"
              >
                {item.label}
              </Link>
            ),
          )}
        </nav>
        <div className="mt-auto flex flex-col gap-2.5 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-xs">
          <div className="flex items-center justify-between text-[#8B98B2]">
            <span>今日状态</span>
            <span className="font-semibold text-[#7FA8F5]">{stageText}</span>
          </div>
          <div className="h-px bg-white/10" />
          <div className="flex items-center justify-between text-[#8B98B2]">
            <span>连续训练</span>
            <span className="font-semibold text-[#E9EEF7]">{streakDays} 天</span>
          </div>
        </div>
      </aside>

      {/* 主区 */}
      <main className="min-w-0 flex-1 px-5 py-8 sm:px-8">{children}</main>
    </div>
  );
}
