"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { fetchProfile, fetchSession, logout } from "./api";
import type { ProfileData, SessionData } from "./contract";
import { ProfileCard } from "./profile-card";
import { SettingsShell } from "./shell";
import { accountViewOf } from "./view-model";

/**
 * 我的页面交互主体（P6 /settings，T15）。
 * 数据流：进入即并行 GET /api/auth/session + GET /api/profile →
 * 账号信息卡（邮箱，开发态显示 dev 标识）→ 初始画像卡（查看/编辑，保存幂等）
 * → 基础设置占位虚态卡 → 退出登录卡（POST /api/auth/logout → /login）。
 * 数据→视图判定走 view-model 纯函数，本组件只负责渲染与调用适配层。
 */

const CARD =
  "rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";

type Phase = "loading" | "ready" | "error";

export function SettingsFlow() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [session, setSession] = useState<SessionData | null>(null);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  /** 手动重试令牌：递增触发 effect 重新拉取 */
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // 延迟到 effect 同步阶段之后执行，避免同步 setState 引发级联渲染
    const timer = setTimeout(() => {
      Promise.all([fetchSession(), fetchProfile()])
        .then(([sessionData, profileData]) => {
          if (cancelled) return;
          setSession(sessionData);
          setProfile(profileData);
          setPhase("ready");
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setErrorMessage(
            error instanceof Error ? error.message : "加载失败，请稍后重试",
          );
          setPhase("error");
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [retryToken]);

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
      router.push("/login");
    } catch (error: unknown) {
      setLogoutError(
        error instanceof Error ? error.message : "退出失败，请稍后重试",
      );
      setLoggingOut(false);
    }
  };

  // 会话缺失时按 dev-identity 约定回退为开发占位身份（含加载中/加载失败场景）
  const account = accountViewOf(session);
  const accountText =
    phase === "loading"
      ? "加载中"
      : phase === "error"
        ? "加载失败"
        : account.email;

  return (
    <SettingsShell accountText={accountText}>
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-4 flex flex-wrap items-baseline gap-3">
          <h1 className="text-xl font-bold">我的</h1>
          <p className="text-xs text-[#94A3B8]">账号信息、初始画像与基础设置</p>
        </div>

        {phase === "loading" ? (
          <div className={`${CARD} animate-pulse p-10 text-center text-sm text-[#94A3B8]`}>
            正在加载我的页面…
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
              className="mt-5 inline-flex items-center gap-2 rounded-xl bg-[#2563EB] px-6 py-3 text-sm font-bold text-white shadow-[0_4px_12px_rgba(37,99,235,0.25)] transition-colors hover:bg-[#1D4ED8]"
            >
              重新加载
            </button>
          </div>
        ) : null}

        {phase === "ready" ? (
          <div className="flex flex-col gap-5 pb-4">
            {/* 账号信息卡 */}
            <section className={`${CARD} px-6 py-5`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-[15px] font-bold">账号信息</h2>
                  <p className="mt-0.5 text-xs text-[#94A3B8]">
                    当前登录的账号邮箱
                  </p>
                </div>
                <span
                  className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                    account.isDev
                      ? "border-amber-200 bg-amber-50 text-amber-600"
                      : "border-emerald-200 bg-emerald-50 text-emerald-700"
                  }`}
                >
                  {account.badge}
                </span>
              </div>
              <div className="mt-4 flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#EFF5FF] text-sm font-bold text-[#2563EB]">
                  {account.email.slice(0, 1).toUpperCase()}
                </div>
                <span className="truncate text-sm font-medium text-[#1E293B]">
                  {account.email}
                </span>
              </div>
            </section>

            {/* 初始画像卡（查看 + 编辑） */}
            <ProfileCard initialProfile={profile} />

            {/* 基础设置占位虚态卡（范围外：训练偏好等高级设置留待后续版本） */}
            <section className="rounded-2xl border-[1.5px] border-dashed border-[#CBD5E3] bg-[#FBFCFE] px-6 py-8 text-center">
              <h2 className="text-sm font-semibold text-[#7A8AA3]">基础设置</h2>
              <p className="mt-1.5 text-xs text-[#A6B2C6]">
                训练偏好、通知等设置将在后续版本开放
              </p>
            </section>

            {/* 退出登录卡 */}
            <section className={`${CARD} flex flex-wrap items-center justify-between gap-3 px-6 py-5`}>
              <div>
                <h2 className="text-[15px] font-bold">退出登录</h2>
                <p className="mt-0.5 text-xs text-[#94A3B8]">
                  退出后将返回登录页，需要重新验证邮箱
                </p>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                disabled={loggingOut}
                className="rounded-xl border border-red-200 bg-red-50 px-5 py-2.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loggingOut ? "退出中…" : "退出登录"}
              </button>
            </section>
            {logoutError ? (
              <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                {logoutError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </SettingsShell>
  );
}
