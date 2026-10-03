import { Suspense } from "react";

import { LoginForm } from "./login-form";

export const metadata = {
  title: "登录 - 训练台",
};

/** 登录页（useSearchParams 需 Suspense 边界） */
export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
