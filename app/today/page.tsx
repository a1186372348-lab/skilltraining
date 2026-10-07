import { redirect } from "next/navigation";

/**
 * T25 / D27⑥：/today 已并入「产品训练」模块——
 * 旧地址 307 重定向到训练大厅（外部书签不失效）。
 */
export default function TodayRedirectPage() {
  redirect("/training");
}
