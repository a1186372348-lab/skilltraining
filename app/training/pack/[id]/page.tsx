import type { Metadata } from "next";
import { PackFlow } from "./pack-flow";

export const metadata: Metadata = { title: "专项训练包 · 训练台" };

export default async function PackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PackFlow packId={id} />;
}
