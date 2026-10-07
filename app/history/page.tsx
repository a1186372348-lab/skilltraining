import { redirect } from "next/navigation";

/**
 * T25 / D27⑥：旧 /history 列表页已被训练大厅取代（不共存）——
 * 旧地址 307 重定向到训练大厅（外部书签不失效）。
 */
export default function HistoryRedirectPage() {
  redirect("/training");
}
