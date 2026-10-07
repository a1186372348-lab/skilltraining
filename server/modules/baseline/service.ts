import type { PrismaClient, Question, TrainingSession } from "@prisma/client";

import { todayUtc } from "@/server/modules/training/service";

import { BASELINE_ERROR_CODES as CODES, BaselineError } from "./errors";

/**
 * 能力基线测评服务（T17a / D19 / BR-9）。
 *
 * 规则：
 * - 基线题池：questions 中 kind=baseline 且 status=published 的题，按 id 升序固定顺序；
 *   预期 2 道综合题合计覆盖 8 维（内容由 T17b 生产），total 以库中实际上架数为准；
 * - 完成计数：用户已评分（scoredAt 非空）的基线题会话数——只认评分完成，
 *   已提交终答未评分不算（中断恢复后仍回到当前题）；
 * - 全部评完 → 写 user_profiles.baseline_completed_at（守卫条件 updateMany，幂等：
 *   并发/重复调用只有首次写入，时间戳不被覆盖）；无画像行的用户跳过写入，不影响判定；
 * - 题库无基线题（T17b 未导入或全部下架）→ required=false，日常训练不受影响；
 * - 基线会话复用训练闭环（提示/追问/评分/独立完成系数完全一致），以 isExtra=true 落库：
 *   每日一题按 {userId, date, isExtra:false} 唯一复用，基线题不能占用该槽位，
 *   否则基线完成当天进入今日训练会错误复用基线会话；画像计入规则与加练一致（D3）。
 */

type DbClient = PrismaClient;

export interface BaselineStatus {
  /** true 表示该用户必须先完成基线测评（今日训练与首页任务卡指向 /baseline） */
  required: boolean;
  /** 上架基线题总数（预期 2） */
  total: number;
  /** 已评分完成的基线题数 */
  doneCount: number;
  /** 按固定顺序的下一道待完成基线题（全部完成或不需要基线时为 null） */
  nextQuestion: Question | null;
  /** 基线完成时间（user_profiles.baseline_completed_at；无画像行或未完成为 null） */
  completedAt: Date | null;
}

/** 读取基线状态；全部评完时幂等补写完成标记（以已评分会话为事实源，标记缺失可自愈） */
export async function getBaselineStatus(db: DbClient, userId: string): Promise<BaselineStatus> {
  const questions = await db.question.findMany({
    where: { kind: "baseline", status: "published" },
    orderBy: { id: "asc" },
  });
  const total = questions.length;
  if (total === 0) {
    return { required: false, total: 0, doneCount: 0, nextQuestion: null, completedAt: null };
  }

  const [profile, scoredSessions] = await Promise.all([
    db.userProfile.findUnique({
      where: { userId },
      select: { baselineCompletedAt: true },
    }),
    db.trainingSession.findMany({
      where: {
        userId,
        questionId: { in: questions.map((question) => question.id) },
        scoredAt: { not: null },
      },
      select: { questionId: true },
    }),
  ]);

  const doneIds = new Set(scoredSessions.map((session) => session.questionId));
  const doneCount = doneIds.size;
  const allScored = doneCount >= total;

  let completedAt = profile?.baselineCompletedAt ?? null;
  if (allScored && completedAt === null) {
    // 幂等写入：守卫 baselineCompletedAt: null，并发/重复调用只有首次生效
    const marker = new Date();
    const written = await db.userProfile.updateMany({
      where: { userId, baselineCompletedAt: null },
      data: { baselineCompletedAt: marker },
    });
    if (written.count > 0) {
      completedAt = marker;
    } else {
      // 并发另一方已写入：回读以其为准；无画像行时保持 null（不影响 required 判定）
      const fresh = await db.userProfile.findUnique({
        where: { userId },
        select: { baselineCompletedAt: true },
      });
      completedAt = fresh?.baselineCompletedAt ?? null;
    }
  }

  const done = allScored || completedAt !== null;
  const nextQuestion = done ? null : (questions.find((question) => !doneIds.has(question.id)) ?? null);
  return { required: !done, total, doneCount, nextQuestion, completedAt };
}

export interface BaselineSessionResult {
  session: TrainingSession;
  question: Question;
  status: BaselineStatus;
}

/**
 * 获取或创建当前基线题的会话（按 {userId, questionId} 幂等复用，中断后可恢复）。
 * 不需要基线时抛 BaselineError(BASELINE_NOT_REQUIRED)，由调用方回退日常训练。
 */
export async function getOrCreateBaselineSession(
  db: DbClient,
  userId: string,
): Promise<BaselineSessionResult> {
  const status = await getBaselineStatus(db, userId);
  if (!status.required || !status.nextQuestion) {
    throw new BaselineError(CODES.BASELINE_NOT_REQUIRED, 409, "能力基线测评已完成或暂不需要");
  }
  const questionId = status.nextQuestion.id;

  const existing = await db.trainingSession.findFirst({
    where: { userId, questionId },
    include: { question: true },
    orderBy: { startedAt: "asc" },
  });
  if (existing) return { session: existing, question: existing.question, status };

  try {
    const session = await db.trainingSession.create({
      data: { userId, questionId, date: todayUtc(), isExtra: true, state: "reading" },
    });
    return { session, question: status.nextQuestion, status };
  } catch {
    // 并发首次进入：另一请求已创建，回读复用（与每日一题同一兜底模式）
    const session = await db.trainingSession.findFirstOrThrow({
      where: { userId, questionId },
      include: { question: true },
      orderBy: { startedAt: "asc" },
    });
    return { session, question: session.question, status };
  }
}
