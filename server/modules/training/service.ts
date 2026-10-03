import type { PrismaClient, Question, TrainingSession } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { generateFollowups, type FollowupInput } from "@/server/ai/followup";
import { SelectionError } from "@/server/modules/selection/errors";
import { selectTodayQuestion } from "@/server/modules/selection/service";

import { independenceCoefficient } from "./coefficient";
import { TRAINING_ERROR_CODES as CODES, TrainingError } from "./errors";
import { nextState } from "./state-machine";
import type { FollowupRecord, ReleasedHint } from "./today-view";

/**
 * 训练会话服务（Prd.md 图 1 的 TRN 模块；US-003/004/005）。
 *
 * 设计要点：
 * - 服务端单一事实源（R4）：提示次数、状态、时间戳全部以数据库为准；
 * - 提交接口幂等：重复提交首答/终答直接返回既有记录，不覆盖、不重复推进、不重复调 AI；
 * - 写入用带守卫条件的 updateMany（原子），避免并发双击导致计数失真；
 * - AI 追问失败不阻塞训练（T05 任务契约：可跳过直达终答），失败计入审计日志；
 * - 【T06 接入点】终答落库后状态保持 followup，评分完成后经 MARK_SCORED 推进 scored；
 * - 选题：T11 自适应出题引擎（探索期/强化期/降级），理由文本供首页「为什么是它」展示。
 */

type DbClient = PrismaClient;

/** 今日 0 点（UTC），与 training_sessions.date（@db.Date）对齐 */
export function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** 自适应选题（T11 引擎）：探索期/强化期/降级由 selection 模块保证；错误码对齐 TrainingError */
async function pickQuestion(db: DbClient, userId: string): Promise<Question> {
  try {
    const { question } = await selectTodayQuestion(db, userId);
    return question;
  } catch (err) {
    if (err instanceof SelectionError) {
      throw new TrainingError(err.code, err.httpStatus, err.message);
    }
    throw err;
  }
}

/** 获取或创建今日会话（每日一题，同一天幂等复用） */
export async function getOrCreateTodaySession(
  db: DbClient,
  userId: string,
): Promise<{ session: TrainingSession; question: Question }> {
  const date = todayUtc();
  const existing = await db.trainingSession.findFirst({
    where: { userId, date, isExtra: false },
    include: { question: true },
    orderBy: { startedAt: "asc" },
  });
  if (existing) return { session: existing, question: existing.question };

  const question = await pickQuestion(db, userId);
  try {
    const session = await db.trainingSession.create({
      data: { userId, questionId: question.id, date, state: "reading" },
    });
    return { session, question };
  } catch {
    // 并发首次进入：另一请求已创建，回读复用（每日一题唯一性兜底）
    const session = await db.trainingSession.findFirstOrThrow({
      where: { userId, date, isExtra: false },
      include: { question: true },
      orderBy: { startedAt: "asc" },
    });
    return { session, question: session.question };
  }
}

/** 加载会话并校验归属（不泄露存在性：他人会话按不存在处理） */
async function loadOwnedSession(
  db: DbClient,
  sessionId: string,
  userId: string,
): Promise<TrainingSession & { question: Question }> {
  const session = await db.trainingSession.findUnique({
    where: { id: sessionId },
    include: { question: true },
  });
  if (!session || session.userId !== userId) {
    throw new TrainingError(CODES.SESSION_NOT_FOUND, 404, "训练会话不存在");
  }
  return session;
}

function parseHintTree(raw: unknown): ReleasedHint[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is ReleasedHint =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { level?: unknown }).level === "number" &&
        typeof (item as { question?: unknown }).question === "string",
    )
    .map((item) => ({ level: item.level, stage: String(item.stage ?? ""), question: item.question }))
    .sort((a, b) => a.level - b.level);
}

export interface HintResult {
  hint: ReleasedHint;
  hintCount: number;
  coefficient: number;
  state: TrainingSession["state"];
}

/** 请求下一层提示（FR-3/BR-3/D5/D7）：写 hint_events，响应携带当前系数 */
export async function requestHint(
  db: DbClient,
  sessionId: string,
  userId: string,
): Promise<HintResult> {
  const session = await loadOwnedSession(db, sessionId, userId);

  // D7：首次提交后提示永久禁用（先于状态机检查，错误语义更准）
  if (session.firstSubmittedAt !== null) {
    throw new TrainingError(CODES.HINT_DISABLED, 409, "首次提交后提示已禁用");
  }
  nextState(session.state, "REQUEST_HINT");
  if (session.hintCount >= 5) {
    throw new TrainingError(CODES.HINTS_EXHAUSTED, 409, "5 层提示已全部释放");
  }

  // 先定位下一层文案（数据异常时快速失败，不空转计数）
  const nextLayer = session.hintCount + 1;
  const hint = parseHintTree(session.question.hintTree).find((h) => h.level === nextLayer);
  if (!hint) {
    // 数据异常：提示树缺层（导入管线已校验 5 层，理论不可达）
    throw new TrainingError(CODES.INVALID_STATE, 500, "提示树数据异常");
  }

  // 原子推进：守卫条件防并发双击导致跳层/超发
  const updated = await db.$transaction(async (tx) => {
    const result = await tx.trainingSession.updateMany({
      where: {
        id: sessionId,
        userId,
        firstSubmittedAt: null,
        hintCount: { lt: 5 },
        state: { in: ["reading", "answering"] },
      },
      data: { hintCount: { increment: 1 }, state: "answering" },
    });
    if (result.count === 0) return null;
    const fresh = await tx.trainingSession.findUniqueOrThrow({ where: { id: sessionId } });
    await tx.hintEvent.create({ data: { sessionId, layer: fresh.hintCount } });
    return fresh;
  });
  if (!updated) {
    // 守卫未命中：并发下状态已变化，重新加载后按当前态报错
    const fresh = await loadOwnedSession(db, sessionId, userId);
    if (fresh.firstSubmittedAt !== null) {
      throw new TrainingError(CODES.HINT_DISABLED, 409, "首次提交后提示已禁用");
    }
    throw new TrainingError(CODES.HINTS_EXHAUSTED, 409, "5 层提示已全部释放");
  }

  return {
    hint,
    hintCount: updated.hintCount,
    coefficient: independenceCoefficient(updated.hintCount),
    state: updated.state,
  };
}

export interface FirstAnswerResult {
  state: TrainingSession["state"];
  followups: string[];
  coefficient: number;
  firstSubmittedAt: Date;
}

export interface FirstAnswerDeps {
  generateFollowups?: (input: FollowupInput) => Promise<string[]>;
}

/** 提交首答（FR-4/BR-4）：状态推进 → 调 AI 生成追问（1~2 轮）存入 followups jsonb */
export async function submitFirstAnswer(
  db: DbClient,
  sessionId: string,
  userId: string,
  answer: string,
  deps: FirstAnswerDeps = {},
): Promise<FirstAnswerResult> {
  const session = await loadOwnedSession(db, sessionId, userId);

  // 幂等：已提交过首答 → 返回既有记录，不覆盖、不重复调 AI
  if (session.firstSubmittedAt !== null) {
    return {
      state: session.state,
      followups: parseStoredFollowupQuestions(session.followups),
      coefficient: independenceCoefficient(session.hintCount),
      firstSubmittedAt: session.firstSubmittedAt,
    };
  }
  nextState(session.state, "SUBMIT_FIRST_ANSWER");

  const submittedAt = new Date();
  const updated = await db.trainingSession.updateMany({
    where: { id: sessionId, userId, firstSubmittedAt: null },
    data: { firstAnswer: answer, firstSubmittedAt: submittedAt, state: "followup" },
  });
  if (updated.count === 0) {
    // 并发重复提交：回读按幂等返回
    const fresh = await loadOwnedSession(db, sessionId, userId);
    return {
      state: fresh.state,
      followups: parseStoredFollowupQuestions(fresh.followups),
      coefficient: independenceCoefficient(fresh.hintCount),
      firstSubmittedAt: fresh.firstSubmittedAt ?? submittedAt,
    };
  }

  // 调 AI 网关生成追问（BR-4：找逻辑漏洞、挑战假设、索要证据）；
  // 失败不阻塞训练（任务契约：可跳过直达终答），followups 置空并记审计日志。
  let followups: string[] = [];
  try {
    const rubric = session.question.rubric as unknown as FollowupInput["rubric"];
    followups = await (deps.generateFollowups ?? generateFollowups)({
      mainQuestion: session.question.mainQuestion,
      firstAnswer: answer,
      rubric,
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "training.followup_generation_failed",
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  const records: FollowupRecord[] = followups.map((question, index) => ({
    round: index + 1,
    question,
  }));
  await db.trainingSession.update({
    where: { id: sessionId },
    // Prisma Json 写入类型要求 InputJsonValue：此处为纯数据对象数组，经 unknown 收窄
    data: { followups: records as unknown as Prisma.InputJsonValue },
  });

  return {
    state: "followup",
    followups,
    coefficient: independenceCoefficient(session.hintCount),
    firstSubmittedAt: submittedAt,
  };
}

function parseStoredFollowupQuestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is FollowupRecord =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { question?: unknown }).question === "string",
    )
    .map((item) => item.question);
}

export interface FinalAnswerResult {
  state: TrainingSession["state"];
  finalSubmittedAt: Date;
}

/** 提交终答：存 final_answer + 时间戳；幂等（重复提交不覆盖不重复推进） */
export async function submitFinalAnswer(
  db: DbClient,
  sessionId: string,
  userId: string,
  answer: string,
): Promise<FinalAnswerResult> {
  const session = await loadOwnedSession(db, sessionId, userId);

  // 幂等：已提交过终答 → 直接返回既有记录
  if (session.finalSubmittedAt !== null) {
    return { state: session.state, finalSubmittedAt: session.finalSubmittedAt };
  }
  nextState(session.state, "SUBMIT_FINAL_ANSWER");

  const submittedAt = new Date();
  const updated = await db.trainingSession.updateMany({
    where: {
      id: sessionId,
      userId,
      firstSubmittedAt: { not: null },
      finalSubmittedAt: null,
    },
    data: { finalAnswer: answer, finalSubmittedAt: submittedAt },
  });
  if (updated.count === 0) {
    const fresh = await loadOwnedSession(db, sessionId, userId);
    if (fresh.finalSubmittedAt !== null) {
      return { state: fresh.state, finalSubmittedAt: fresh.finalSubmittedAt };
    }
    throw new TrainingError(CODES.FIRST_ANSWER_REQUIRED, 409, "请先提交首次答案");
  }

  // 【T06 接入点】终答已落库；状态保持 followup，
  // T06 评分任务完成后调用 nextState(state, "MARK_SCORED") 推进 scored 并写 scores 表。
  return { state: "followup", finalSubmittedAt: submittedAt };
}
