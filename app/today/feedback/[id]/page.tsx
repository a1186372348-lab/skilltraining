import { redirect } from "next/navigation";

/**
 * T25 / D27⑥：反馈页已迁入「产品训练」模块——
 * 旧地址 307 重定向到 /training/feedback/[id]（外部书签不失效）。
 */
export default async function TodayFeedbackRedirectPage({
  params,
}: PageProps<"/today/feedback/[id]">) {
  const { id } = await params;
  redirect(`/training/feedback/${id}`);
}
