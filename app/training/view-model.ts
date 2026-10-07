import type { HubCurrentCard, HubHistoryItem, HubInProgressCard, HubSessionStage } from "./contract";

/**
 * 产品训练大厅视图模型（纯函数，T25 / D27）。
 * 把"大厅数据 → 界面"的全部判定集中在这里，组件只负责渲染；
 * 无 DOM/React 依赖，可在 node 环境用 vitest 直接覆盖（同 app/training/session/view-model.ts 模式）。
 * 视觉与文案以 prototypes/prototype-training-hub.html 为准（产品负责人已拍板）。
 */

/** 阶段文案：作答中 / 追问中 / 评分中（当前卡徽章、历史行徽章、侧栏状态共用口径） */
export function hubStageText(stage: HubSessionStage): string {
  switch (stage) {
    case "answering":
      return "作答中";
    case "followup":
      return "追问中";
    case "scoring":
      return "评分中";
  }
}

/** 进行中卡的状态徽章（原型：badge-blue「进行中 · 作答中」） */
export function currentBadgeText(current: HubInProgressCard): string {
  return `进行中 · ${hubStageText(current.stage)}`;
}

/** 进行中卡的进度行文案（原型蓝底提示条；追问阶段沿用原型拍板原文） */
export function progressLineFor(stage: HubSessionStage): string {
  switch (stage) {
    case "answering":
      return "正在阅读案例与作答，完成后 AI 产品总监将追问";
    case "followup":
      return "已完成首次作答，等待你回应总监追问";
    case "scoring":
      return "最终答案已提交，产品总监正在按评分细则评阅";
  }
}

/** 进行中卡按钮旁的小字提示（追问阶段沿用原型拍板原文） */
export function actionNoteFor(stage: HubSessionStage): string {
  switch (stage) {
    case "answering":
      return "卡住时可以逐级请求提示（会影响独立完成系数）";
    case "followup":
      return "追问不扣分，放心补充你的判断";
    case "scoring":
      return "评分通常需要 30~60 秒，可稍后在反馈页查看";
  }
}

export interface ContinueAction {
  label: string;
  href: string;
}

/**
 * 进行中卡主按钮：作答/追问 →「继续训练」回工作台（按会话寻址，D27②）；
 * 评分中 →「查看评分进度」去反馈页（评分等待态与轮询由反馈页承接，T07 既有能力）。
 */
export function continueActionFor(current: HubInProgressCard): ContinueAction {
  if (current.stage === "scoring") {
    return { label: "查看评分进度", href: `/training/feedback/${current.sessionId}` };
  }
  return { label: "继续训练", href: `/training/session/${current.sessionId}` };
}

/** 侧栏底部「今日状态」：进行中取阶段文案；未开始 / 已完成对应待开始 / 已完成 */
export function sidebarStageText(current: HubCurrentCard): string {
  switch (current.kind) {
    case "in_progress":
      return hubStageText(current.stage);
    case "not_started":
      return "待开始";
    case "completed":
      return "已完成";
  }
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

/** ISO 日期（YYYY-MM-DD）→「2026年10月7日 星期三」（UTC 算星期，防时区漂移）；非法输入原样返回 */
export function formatHubDateKey(dateKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return dateKey;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${year}年${month}月${day}日 星期${weekday}`;
}

/** 两位补零 */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 历史行时间（原型：今天 16:05 / 10月5日）：与 now 同本地日 → 今天 HH:mm；同年 → M月D日；跨年 → YYYY年M月D日；非法时间显示占位文案 */
export function formatHubTime(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "时间缺失";
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `今天 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export type HistoryStatusTone = "doing" | "scoring" | "done";

/**
 * 历史行状态徽章（原型：已完成绿 / 评分中蓝 / 作答中·追问中灰）：
 * scored → 已完成；followup 已交终答 → 评分中；followup 未交终答 → 追问中；其余 → 作答中。
 */
export function historyStatusFor(item: HubHistoryItem): { text: string; tone: HistoryStatusTone } {
  if (item.state === "scored") return { text: "已完成", tone: "done" };
  if (item.state === "followup") {
    return item.hasFinalAnswer
      ? { text: "评分中", tone: "scoring" }
      : { text: "追问中", tone: "doing" };
  }
  return { text: "作答中", tone: "doing" };
}

/**
 * 历史行跳转（D27②⑤）：
 * 未完成 → 工作台 /training/session/[id]（「作答中」的旧会话点回继续）；
 * 已完成 → 只读详情 /training/history/[id]（历史回看沿用只读详情页）。
 */
export function historyHrefFor(item: HubHistoryItem): string {
  return item.state === "scored"
    ? `/training/history/${item.sessionId}`
    : `/training/session/${item.sessionId}`;
}
