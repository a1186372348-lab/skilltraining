import type { Metadata } from "next";
import { TodayShell } from "@/app/training/session/shell";
import { StageFlow } from "./stage-flow";

export const metadata: Metadata = { title: "成长阶段 · 训练台" };

export default function StagesPage() {
  return <TodayShell stageText="成长阶段" activeLabel="成长阶段"><StageFlow /></TodayShell>;
}
