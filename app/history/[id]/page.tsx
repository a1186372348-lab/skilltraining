import { redirect } from "next/navigation";

/**
 * T25 / D27⑥：历史详情已迁入「产品训练」模块——
 * 旧地址 307 重定向到 /training/history/[id]（外部书签不失效）。
 */
export default async function HistoryDetailRedirectPage({
  params,
}: PageProps<"/history/[id]">) {
  const { id } = await params;
  redirect(`/training/history/${id}`);
}
