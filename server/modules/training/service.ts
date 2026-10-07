import type { PrismaClient, Question, TrainingSession } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { generateFollowups, type FollowupDraft, type FollowupInput } from "@/server/ai/followup";
import { SelectionError } from "@/server/modules/selection/errors";
import { selectTodayQuestion } from "@/server/modules/selection/service";

import { independenceCoefficient } from "./coefficient";
import { TRAINING_ERROR_CODES as CODES, TrainingError } from "./errors";
import { nextState } from "./state-machine";
import {
  parseFollowupRecords,
  toFollowupViews,
  toTodayView,
  type FollowupRecord,
  type FollowupView,
  type ReleasedHint,
  type TodayView,
} from "./today-view";

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

/**
 * 获取或创建加练会话（T21 / D3：加练同等计入画像）：
 * 当天存在未提交终答的非基线会话时幂等复用（防连点重复建题；每日或加练均可，
 * 任意时刻至多一个进行中会话），否则经选题引擎选新题落库（isExtra=true）。
 * 查询一律按 question.kind="daily" 过滤：基线会话同样是 isExtra=true，不能混淆（T17a / D19）。
 */
export async function getOrCreateExtraSession(
  db: DbClient,
  userId: string,
): Promise<{ session: TrainingSession; question: Question }> {
  const date = todayUtc();
  const existing = await db.trainingSession.findFirst({
    where: { userId, date, finalAnswer: null, question: { kind: "daily" } },
    include: { question: true },
    orderBy: { startedAt: "asc" },
  });
  if (existing) return { session: existing, question: existing.question };

  const question = await pickQuestion(db, userId);
  try {
    const session = await db.trainingSession.create({
      data: { userId, questionId: question.id, date, isExtra: true, state: "reading" },
    });
    return { session, question };
  } catch {
    // 并发创建冲突：另一请求已建加练，回读复用（与每日一题同一兜底模式）
    const session = await db.trainingSession.findFirstOrThrow({
      where: { userId, date, isExtra: true, question: { kind: "daily" } },
      include: { question: true },
      orderBy: { startedAt: "asc" },
    });
    return { session, question: session.question };
  }
}

/**
 * 返回当天最近一个非基线会话（startedAt 倒序；进行中自然优先——
 * 加练只在全部完成后才可创建，任意时刻至多一个进行中会话）；无会话返回 null。
 */
export async function getLatestDailySession(
  db: DbClient,
  userId: string,
): Promise<{ session: TrainingSession; question: Question } | null> {
  const session = await db.trainingSession.findFirst({
    where: { userId, date: todayUtc(), question: { kind: "daily" } },
    include: { question: true },
    orderBy: { startedAt: "desc" },
  });
  if (!session) return null;
  return { session, question: session.question };
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

/**
 * 单会话工作台载荷（T25 / D27：GET /api/training/[id]，/training/session/[id] 按会话寻址）。
 * 归属校验（他人/不存在一律 404，不泄露存在性）后复用 today 视图构建器，
 * 与 GET /api/training/today 载荷同构；历史列表中「作答中」的旧会话同样可取回继续。
 * 基线会话（question.kind=baseline）拒绝：不属于日常工作台路由，前端据 code 重定向 /baseline。
 */
export async function getSessionTodayView(
  db: DbClient,
  sessionId: string,
  userId: string,
): Promise<TodayView> {
  const session = await loadOwnedSession(db, sessionId, userId);
  if (session.question.kind === "baseline") {
    throw new TrainingError(CODES.BASELINE_SESSION, 409, "该会话为基线测评，请前往 /baseline");
  }
  return toTodayView(session, session.question);
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
    coefficient: independenceCoefficient(updated.hintCount, updated.followupHintCount),
    state: updated.state,
  };
}

export interface FirstAnswerResult {
  state: TrainingSession["state"];
  followups: FollowupView[];
  coefficient: number;
  firstSubmittedAt: Date;
}

export interface FirstAnswerDeps {
  generateFollowups?: (input: FollowupInput) => Promise<FollowupDraft[]>;
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
      followups: toFollowupViews(parseFollowupRecords(session.followups)),
      coefficient: independenceCoefficient(session.hintCount, session.followupHintCount),
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
      followups: toFollowupViews(parseFollowupRecords(fresh.followups)),
      coefficient: independenceCoefficient(fresh.hintCount, fresh.followupHintCount),
      firstSubmittedAt: fresh.firstSubmittedAt ?? submittedAt,
    };
  }

  // 调 AI 网关生成追问（BR-4：找逻辑漏洞、挑战假设、索要证据）；
  // T19（D22）：同一次调用为每条追问附带一条预生成提示，随追问一并落库，
  // 用户点击时读库零等待。失败不阻塞训练（任务契约：可跳过直达终答），
  // followups 置空并记审计日志。
  let drafts: FollowupDraft[] = [];
  try {
    const rubric = session.question.rubric as unknown as FollowupInput["rubric"];
    drafts = await (deps.generateFollowups ?? generateFollowups)({
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

  const records: FollowupRecord[] = drafts.map((draft, index) => ({
    round: index + 1,
    question: draft.question,
    hint: draft.hint,
    hintReleased: false,
  }));
  await db.trainingSession.update({
    where: { id: sessionId },
    // Prisma Json 写入类型要求 InputJsonValue：此处为纯数据对象数组，经 unknown 收窄
    data: { followups: records as unknown as Prisma.InputJsonValue },
  });

  return {
    state: "followup",
    followups: toFollowupViews(records),
    coefficient: independenceCoefficient(session.hintCount, session.followupHintCount),
    firstSubmittedAt: submittedAt,
  };
}

export interface FollowupHintResult {
  round: number;
  hint: string;
  followupHintCount: number;
  coefficient: number;
}

/**
 * 释放某轮追问的预生成提示（T19 / D22）：读库返回，零 AI 等待。
 * - 前置：会话处于 followup 状态（首答已提交）、该 round 存在且有非空预生成提示；
 * - 幂等：同一 round 重复请求返回已释放 hint，不重复计数（每轮最多释放 1 次）；
 * - 原子：followupHintCount 以带守卫条件的 updateMany 自增，并发双击只计 1 次；
 *   守卫未命中时重读重试（并发另一方已释放同一轮时走幂等分支返回）。
 */
export async function requestFollowupHint(
  db: DbClient,
  sessionId: string,
  userId: string,
  round: number,
): Promise<FollowupHintResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const session = await loadOwnedSession(db, sessionId, userId);

    // D22：追问提示是独立入口，但仅在追问阶段（首答已提交、评分未完成）可用
    if (session.state !== "followup" || session.firstSubmittedAt === null) {
      throw new TrainingError(CODES.INVALID_STATE, 409, "当前状态不可请求追问提示");
    }

    const records = parseFollowupRecords(session.followups);
    const target = records.find((record) => record.round === round);
    if (!target) {
      throw new TrainingError(CODES.FOLLOWUP_NOT_FOUND, 404, "追问轮次不存在");
    }
    if (target.hintReleased) {
      // 幂等：已释放 → 直接返回既有 hint，不重复计数
      return {
        round,
        hint: target.hint,
        followupHintCount: session.followupHintCount,
        coefficient: independenceCoefficient(session.hintCount, session.followupHintCount),
      };
    }
    if (!target.hint.trim()) {
      // AI 降级未产出提示 / 存量老记录无 hint 字段：该轮不可释放
      throw new TrainingError(CODES.FOLLOWUP_HINT_NOT_AVAILABLE, 409, "该轮追问没有可用提示");
    }

    const nextRecords = records.map((record) =>
      record.round === round ? { ...record, hintReleased: true } : record,
    );
    const releasedCount = await db.$transaction(async (tx) => {
      // 原子自增：守卫条件（状态 + 当前计数）防并发双击重复计数
      const guard = await tx.trainingSession.updateMany({
        where: {
          id: sessionId,
          userId,
          state: "followup",
          followupHintCount: session.followupHintCount,
        },
        data: { followupHintCount: { increment: 1 } },
      });
      if (guard.count === 0) return null;
      await tx.trainingSession.update({
        where: { id: sessionId },
        data: { followups: nextRecords as unknown as Prisma.InputJsonValue },
      });
      return session.followupHintCount + 1;
    });
    if (releasedCount === null) continue; // 并发冲突：重读后按幂等/重试处理

    return {
      round,
      hint: target.hint,
      followupHintCount: releasedCount,
      coefficient: independenceCoefficient(session.hintCount, releasedCount),
    };
  }
  // 连续并发冲突（理论不可达：每会话至多 2 轮追问提示）
  throw new TrainingError(CODES.INVALID_STATE, 409, "请求冲突，请重试");
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
