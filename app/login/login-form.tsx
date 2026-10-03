"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

/** 核销失败回跳的 error 参数 → 用户可读提示（不含内部细节） */
const ERROR_MESSAGES: Record<string, string> = {
  invalid_link: "登录链接已失效或已使用，请重新发送。",
  rate_limited: "操作过于频繁，请稍后再试。",
};

/**
 * 登录表单：输入邮箱 → 发送魔法链接 → 统一成功提示。
 * 响应口径不区分邮箱是否已注册（与服务端一致）。
 */
export function LoginForm() {
  const searchParams = useSearchParams();
  const errorParam = searchParams.get("error");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(
    errorParam ? (ERROR_MESSAGES[errorParam] ?? null) : null,
  );

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/auth/send-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await res.json()) as
        | { ok: true; data: { message: string } }
        | { ok: false; error: { code: string; message: string } };
      if (body.ok) {
        setSent(true);
      } else {
        setErrorMessage(body.error.message);
      }
    } catch {
      setErrorMessage("网络异常，请稍后再试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">邮箱登录</h1>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        免密码登录：我们会向你的邮箱发送一次性登录链接。
      </p>

      {sent ? (
        <div className="mt-6 rounded-lg bg-emerald-50 p-4 text-sm leading-6 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          如果该邮箱可用于登录，我们已向它发送登录链接，请查收邮件（15
          分钟内有效，仅可使用一次）。开发环境下链接会输出到服务端控制台。
        </div>
      ) : (
        <form className="mt-6 flex flex-col gap-4" onSubmit={onSubmit}>
          <label className="flex flex-col gap-1.5 text-sm text-zinc-700 dark:text-zinc-300">
            邮箱
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="h-11 rounded-lg border border-zinc-300 bg-transparent px-3 text-zinc-900 outline-none transition-colors focus:border-zinc-900 dark:border-zinc-700 dark:text-zinc-50 dark:focus:border-zinc-300"
            />
          </label>
          {errorMessage ? (
            <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
          ) : null}
          <button
            type="submit"
            disabled={pending}
            className="h-11 rounded-lg bg-zinc-900 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {pending ? "发送中…" : "发送登录链接"}
          </button>
        </form>
      )}
    </div>
  );
}
