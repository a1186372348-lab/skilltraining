import type { PrismaClient, Question, TrainingSession } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { generateFollowups, type FollowupGateResult, type FollowupInput } from "@/server/ai/followup";
import { FOLLOWUP_PROMPT_V1 } from "@/server/ai/prompts/followup.v1";
import { resolvePromptTemplates } from "@/server/ai/prompts/resolver";
import { SelectionError } from "@/server/modules/selection/errors";
import { selectTodayQuestion } from "@/server/modules/selection/service";

import { independenceCoefficient } from "./coefficient";
import { TRAINING_ERROR_CODES as CODES, TrainingError } from "./errors";
import { nextState } from "./state-machine";
import {
  buildFollowupGateDecisionRecord,
  parseFollowupGateSkip,
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

/** 获取或创建今日会话（每日一题，同一天幂等复用；T38 / D40：已终止会话不复用，重建出新题） */
export async function getOrCreateTodaySession(
  db: DbClient,
  userId: string,
): Promise<{ session: TrainingSession; question: Question }> {
  const date = todayUtc();
  const existing = await db.trainingSession.findFirst({
    where: { userId, date, isExtra: false, state: { not: "abandoned" } },
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
      where: { userId, date, isExtra: false, state: { not: "abandoned" } },
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
 * T38 / D40：已终止会话不复用（state 排除 abandoned）——终止加练后再练一题出新题。
 */
export async function getOrCreateExtraSession(
  db: DbClient,
  userId: string,
): Promise<{ session: TrainingSession; question: Question }> {
  const date = todayUtc();
  const existing = await db.trainingSession.findFirst({
    where: { userId, date, finalAnswer: null, state: { not: "abandoned" }, question: { kind: "daily" } },
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
      where: { userId, date, isExtra: true, state: { not: "abandoned" }, question: { kind: "daily" } },
      include: { question: true },
      orderBy: { startedAt: "asc" },
    });
    return { session, question: session.question };
  }
}

/**
 * 返回当天最近一个非基线会话（startedAt 倒序；进行中自然优先——
 * 加练只在全部完成后才可创建，任意时刻至多一个进行中会话）；无会话返回 null。
 * T38 / D40：已终止会话不算「最近会话」（用户已放弃，today 据此重建新会话）。
 */
export async function getLatestDailySession(
  db: DbClient,
  userId: string,
): Promise<{ session: TrainingSession; question: Question } | null> {
  const session = await db.trainingSession.findFirst({
    where: { userId, date: todayUtc(), state: { not: "abandoned" }, question: { kind: "daily" } },
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
 * T38 / D40：已终止会话拒绝（409 SESSION_ABANDONED），前端据 code 重定向训练大厅。
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
  if (session.state === "abandoned") {
    throw new TrainingError(CODES.SESSION_ABANDONED, 409, "该训练已终止，请回到训练大厅重新开始");
  }
  return toTodayView(session, session.question);
}

export interface AbandonResult {
  state: TrainingSession["state"];
}

/**
 * 终止训练会话（T38 / D40：「重启训练」的服务端能力）：
 * - 守卫：仅未提交终答的日常会话（含加练）可终止——基线会话 409 BASELINE_SESSION（D19 门禁不变）、
 *   已提交终答 409 FINAL_ANSWER_ALREADY_SUBMITTED、已评分 409 SESSION_ALREADY_SCORED；
 * - 幂等：已 abandoned 直接返回成功（重复点击/重试不报错）；
 * - 原子：带守卫条件的 updateMany 推进（与终答幂等同款），并发双击只有首次生效；
 * - 零损失：只推进 state，作答与提示数据全部保留（历史以「已终止」展示，不评分不计入画像）。
 */
export async function abandonSession(
  db: DbClient,
  sessionId: string,
  userId: string,
): Promise<AbandonResult> {
  const session = await loadOwnedSession(db, sessionId, userId);

  // 基线会话不属于可终止范围（先于幂等分支判定：基线永不终止，语义更准）
  if (session.question.kind === "baseline") {
    throw new TrainingError(CODES.BASELINE_SESSION, 409, "基线测评不可终止，请完成测评");
  }
  // 幂等：已终止 → 直接成功
  if (session.state === "abandoned") return { state: "abandoned" };
  // 已提交终答（评分在路上）与已评分会话无终止意义（先于状态机检查，错误语义更准）
  if (session.state === "scored") {
    throw new TrainingError(CODES.SESSION_ALREADY_SCORED, 409, "会话已评分，不可终止");
  }
  if (session.finalSubmittedAt !== null) {
    throw new TrainingError(
      CODES.FINAL_ANSWER_ALREADY_SUBMITTED,
      409,
      "最终答案已提交，评分进行中，不可终止",
    );
  }
  nextState(session.state, "ABANDON");

  // 原子推进：守卫条件（进行中三态 + 未交终答）防并发双击与「终止-交卷」竞态
  const updated = await db.trainingSession.updateMany({
    where: {
      id: sessionId,
      userId,
      state: { in: ["reading", "answering", "followup"] },
      finalSubmittedAt: null,
    },
    data: { state: "abandoned" },
  });
  if (updated.count === 0) {
    // 守卫未命中：并发下状态已变化，重新加载后按当前态分流
    const fresh = await loadOwnedSession(db, sessionId, userId);
    if (fresh.state === "abandoned") return { state: "abandoned" };
    if (fresh.state === "scored") {
      throw new TrainingError(CODES.SESSION_ALREADY_SCORED, 409, "会话已评分，不可终止");
    }
    if (fresh.finalSubmittedAt !== null) {
      throw new TrainingError(
        CODES.FINAL_ANSWER_ALREADY_SUBMITTED,
        409,
        "最终答案已提交，评分进行中，不可终止",
      );
    }
    throw new TrainingError(CODES.INVALID_STATE, 409, "当前状态不可终止训练");
  }
  return { state: "abandoned" };
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
  /** 追问闸门跳过（T35 / D37）：闸门判定无需追问为 true（空追问 ≠ 生成失败） */
  followupGateSkipped: boolean;
  coefficient: number;
  firstSubmittedAt: Date;
}

/** 追问生成注入点（测试 mock AI，不出网）；submitFirstAnswer 与 retryFollowups 共用 */
export interface FollowupGenerationDeps {
  generateFollowups?: (input: FollowupInput) => Promise<FollowupGateResult>;
}

/** 主测维度（T35 / D37：abilityTags[0] 为闸门判定锚点）；脏数据兜底 undefined（prompt 降级通用表述） */
function primaryDimensionOf(question: Question): string | undefined {
  const tags = question.abilityTags;
  if (!Array.isArray(tags)) return undefined;
  const first = tags[0];
  return typeof first === "string" && first.trim() ? first : undefined;
}

/**
 * 生成追问并落库（BR-4 + T19/D22：同一次调用为每条追问附带预生成提示，随追问一并落库，
 * 用户点击时读库零等待）。submitFirstAnswer 与 retryFollowups（T37 / D39）共用。
 * - T35 / D37 追问闸门：同一次调用先判定必要性——两分支都落 gate_decision 判定记录
 *   （首元素，含 shouldFollowup 与判定理由 reason，仅审计不下发）：判定追问则轮次跟随其后，
 *   判定跳过则无轮次（直进终答），两者都与「生成失败的空数组」可区分；
 * - 失败不阻塞训练（任务契约：可跳过直达终答）：followups 置空并记审计日志。
 */
async function generateAndStoreFollowups(
  db: DbClient,
  session: TrainingSession & { question: Question },
  firstAnswer: string,
  deps: FollowupGenerationDeps = {},
): Promise<{ records: FollowupRecord[]; gateSkipped: boolean }> {
  let gate: FollowupGateResult | null = null;
  try {
    const rubric = session.question.rubric as unknown as FollowupInput["rubric"];
    // prompt 模板（T28 / D31）：DB active 版本优先，无 active 回退文件版本（resolver 进程内缓存）
    const templates = await resolvePromptTemplates(db, FOLLOWUP_PROMPT_V1);
    const run = deps.generateFollowups ?? ((input: FollowupInput) => generateFollowups(input, { templates }));
    gate = await run({
      mainQuestion: session.question.mainQuestion,
      firstAnswer,
      rubric,
      primaryDimension: primaryDimensionOf(session.question),
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "training.followup_generation_failed",
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  // 闸门跳过（T35 / D37）：判定记录单独落库（无追问轮次）；reason 仅落库审计，不下发前端
  if (gate !== null && !gate.shouldFollowup) {
    const decision = buildFollowupGateDecisionRecord(false, gate.reason);
    await db.trainingSession.update({
      where: { id: session.id },
      data: { followups: [decision] as unknown as Prisma.InputJsonValue },
    });
    console.info(
      JSON.stringify({
        event: "training.followup_gate_skipped",
        sessionId: session.id,
        reason: gate.reason,
      }),
    );
    return { records: [], gateSkipped: true };
  }

  const records: FollowupRecord[] = (gate?.followups ?? []).map((draft, index) => ({
    round: index + 1,
    question: draft.question,
    hint: draft.hint,
    hintReleased: false,
  }));
  // 判定记录恒为首元素（两分支落库：判定追问同样留痕，供 gate-probe 分布监测），轮次跟在其后；
  // 生成失败（gate 为 null）保持空数组——无判定可记，语义为失败态
  const stored =
    gate === null ? records : [buildFollowupGateDecisionRecord(true, gate.reason), ...records];
  await db.trainingSession.update({
    where: { id: session.id },
    // Prisma Json 写入类型要求 InputJsonValue：此处为纯数据对象数组，经 unknown 收窄
    data: { followups: stored as unknown as Prisma.InputJsonValue },
  });
  return { records, gateSkipped: false };
}

/** 提交首答（FR-4/BR-4；T35 / D37 追问闸门）：状态推进 → 同一次 AI 调用先判定是否追问——判定无需追问则落 gate_decision 判定记录（直进终答），否则生成 1~2 轮追问随判定记录存入 followups jsonb */
export async function submitFirstAnswer(
  db: DbClient,
  sessionId: string,
  userId: string,
  answer: string,
  deps: FollowupGenerationDeps = {},
): Promise<FirstAnswerResult> {
  const session = await loadOwnedSession(db, sessionId, userId);

  // 幂等：已提交过首答 → 返回既有记录，不覆盖、不重复调 AI
  if (session.firstSubmittedAt !== null) {
    return {
      state: session.state,
      followups: toFollowupViews(parseFollowupRecords(session.followups)),
      followupGateSkipped: parseFollowupGateSkip(session.followups) !== null,
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
      followupGateSkipped: parseFollowupGateSkip(fresh.followups) !== null,
      coefficient: independenceCoefficient(fresh.hintCount, fresh.followupHintCount),
      firstSubmittedAt: fresh.firstSubmittedAt ?? submittedAt,
    };
  }

  // 调 AI 网关生成追问（BR-4：找逻辑漏洞、挑战假设、索要证据）；
  // 失败不阻塞训练（任务契约：可跳过直达终答），followups 置空并记审计日志。
  const { records, gateSkipped } = await generateAndStoreFollowups(db, session, answer, deps);

  return {
    state: "followup",
    followups: toFollowupViews(records),
    followupGateSkipped: gateSkipped,
    coefficient: independenceCoefficient(session.hintCount, session.followupHintCount),
    firstSubmittedAt: submittedAt,
  };
}

export interface FollowupRetryResult {
  state: TrainingSession["state"];
  followups: FollowupView[];
  /** 追问闸门跳过（T35 / D37）：重试后闸门判定无需追问为 true（空追问 ≠ 再次失败） */
  followupGateSkipped: boolean;
  coefficient: number;
  firstSubmittedAt: Date;
}

/**
 * 追问生成失败后的用户侧重试（T37 / D39；T35 / D37 闸门守卫）：
 * - 仅失败态可重试：state=followup、已提交首答、未提交终答、当前 followups 为空数组；
 * - 闸门守卫（T35）：闸门跳过的会话（followups 含 gate_skip 审计标记）不可按失败重试，
 *   返回 409 FOLLOWUP_GATE_SKIPPED；
 * - 幂等：followups 非空时直接返回既有追问，不覆盖、不重复调 AI；
 * - 重试重新走带闸门的生成：本次判定该追问则正常出追问；判定无需追问则落 gate_skip
 *   标记并返回 followupGateSkipped=true（前端切正向零追问卡，非失败态）；
 * - 失败语义与首答一致：再次失败返回空 followups（落库空数组并记审计日志），
 *   由前端按失败态处理（可再试或跳过追问直接作答）。
 */
export async function retryFollowups(
  db: DbClient,
  sessionId: string,
  userId: string,
  deps: FollowupGenerationDeps = {},
): Promise<FollowupRetryResult> {
  const session = await loadOwnedSession(db, sessionId, userId);

  if (
    session.state !== "followup" ||
    session.firstSubmittedAt === null ||
    session.firstAnswer === null ||
    session.finalSubmittedAt !== null
  ) {
    throw new TrainingError(CODES.INVALID_STATE, 409, "当前状态不可重试追问生成");
  }

  // T35 / D37：闸门已判定无需追问——不是失败态，不可重试生成（先于幂等分支判定）
  if (parseFollowupGateSkip(session.followups) !== null) {
    throw new TrainingError(CODES.FOLLOWUP_GATE_SKIPPED, 409, "总监已判定无需追问，可直接提交最终答案");
  }

  const existing = parseFollowupRecords(session.followups);
  if (existing.length > 0) {
    // 幂等：已有追问 → 返回既有记录，不重复调 AI
    return {
      state: session.state,
      followups: toFollowupViews(existing),
      followupGateSkipped: false,
      coefficient: independenceCoefficient(session.hintCount, session.followupHintCount),
      firstSubmittedAt: session.firstSubmittedAt,
    };
  }

  const { records, gateSkipped } = await generateAndStoreFollowups(db, session, session.firstAnswer, deps);
  return {
    state: session.state,
    followups: toFollowupViews(records),
    followupGateSkipped: gateSkipped,
    coefficient: independenceCoefficient(session.hintCount, session.followupHintCount),
    firstSubmittedAt: session.firstSubmittedAt,
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
    // T35：gate_decision 判定记录等非轮次元素必须原样保留在回写数组中（否则被 records 回写冲掉）
    const rawList = Array.isArray(session.followups) ? session.followups : [];
    const preservedMarkers = rawList.filter(
      (item) =>
        !(
          typeof item === "object" &&
          item !== null &&
          typeof (item as { round?: unknown }).round === "number" &&
          typeof (item as { question?: unknown }).question === "string"
        ),
    );
    const storedRecords = [...preservedMarkers, ...nextRecords];
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
        data: { followups: storedRecords as unknown as Prisma.InputJsonValue },
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
