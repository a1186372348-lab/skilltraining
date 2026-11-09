import type {
  AbandonSessionResponse,
  ExtraSessionResponse,
  FinalAnswerResponse,
  FirstAnswerResponse,
  FollowupHintResponse,
  FollowupRetryResponse,
  FollowupRound,
  HintResponse,
  TodayView,
} from "./contract";

/** 今日训练真实 API 适配层，保持统一错误及历史响应兼容。 */

/** 统一响应封装的服务端错误形状（与 server/lib/api-response.ts 对齐） */
interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/**
 * 带服务端错误码的 API 错误：页面按 code 分支处理
 *（T25：BASELINE_SESSION → 工作台重定向 /baseline；SESSION_NOT_FOUND → 会话不存在态）。
 */
export class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

/** 真实接口调用：解析统一响应封装，失败时抛出带服务端 code 与 message 的错误 */
async function callApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.success) {
    throw new ApiError(
      json.error?.code ?? "UNKNOWN",
      json.error?.message ?? "请求失败，请稍后重试",
    );
  }
  return json.data as T;
}

/**
 * 归一化追问记录：服务端 today 视图/首答响应均为 { round, question, hasHint, hintReleased, hint }，
 * 历史联调期的 string[] 形态也兼容（按无提示处理）。
 */
function normalizeFollowups(raw: unknown): FollowupRound[] {
  if (!Array.isArray(raw)) return [];
  const rounds: FollowupRound[] = [];
  raw.forEach((item, index) => {
    if (typeof item === "string" && item.trim()) {
      rounds.push({ round: index + 1, question: item, hasHint: false, hintReleased: false, hint: null });
    } else if (
      item !== null &&
      typeof item === "object" &&
      typeof (item as { question?: unknown }).question === "string"
    ) {
      const entry = item as {
        round?: unknown;
        question: string;
        hasHint?: unknown;
        hintReleased?: unknown;
        hint?: unknown;
      };
      const hintReleased = entry.hintReleased === true;
      const hint = typeof entry.hint === "string" ? entry.hint : null;
      rounds.push({
        round: typeof entry.round === "number" ? entry.round : index + 1,
        question: entry.question,
        hasHint: entry.hasHint === true || (hintReleased && hint !== null),
        hintReleased,
        // FR-10：未释放时不保留下发侧 hint 字段（服务端本就不下发，这里再兜一层）
        hint: hintReleased ? hint : null,
      });
    }
  });
  return rounds;
}

/** 归一化 today 视图：补齐可能缺失的派生字段（hintCount / canRequestHint / followups / caseSources / firstSubmittedAt） */
function normalizeTodayView(raw: TodayView): TodayView {
  const releasedHints = Array.isArray(raw.releasedHints) ? raw.releasedHints : [];
  const hintCount = typeof raw.hintCount === "number" ? raw.hintCount : releasedHints.length;
  return {
    ...raw,
    hintCount,
    releasedHints,
    followups: normalizeFollowups(raw.followups),
    // T35：追问闸门跳过标记；联调期服务端未下发时兜底 false（按生成中/失败通道处理）
    followupGateSkipped: raw.followupGateSkipped === true,
    // T22：追问生成中/失败判定依据；联调期服务端未下发时兜底 null（按失败处理）
    firstSubmittedAt: typeof raw.firstSubmittedAt === "string" ? raw.firstSubmittedAt : null,
    // T13：案例来源为新增字段，联调期服务端未下发时兜底为空列表（案例卡退化为无引用态）
    caseSources: Array.isArray(raw.caseSources) ? raw.caseSources : [],
    canRequestHint:
      typeof raw.canRequestHint === "boolean"
        ? raw.canRequestHint
        : (raw.state === "reading" || raw.state === "answering") && hintCount < 5,
  };
}

/** GET /api/training/today：今日会话（含题目与已释放提示，刷新恢复的数据源） */
export async function fetchTodaySession(mode?: "daily"): Promise<TodayView | null> {
  const data = await callApi<TodayView | null>(mode === "daily" ? "/api/training/today?mode=daily" : "/api/training/today");
  return data ? normalizeTodayView(data) : null;
}

/**
 * GET /api/training/:id（T25 / D27）：单会话工作台载荷（/training/session/[id] 按会话寻址）。
 * 与 today 载荷同构；基线会话抛 ApiError(BASELINE_SESSION)，调用方据此重定向 /baseline。
 */
export async function fetchSessionById(sessionId: string): Promise<TodayView | null> {
  const data = await callApi<TodayView | null>(`/api/training/${sessionId}`);
  return data ? normalizeTodayView(data) : null;
}

/** POST /api/training/:id/hint：释放下一层提示，响应携带当前系数（FR-3） */
export async function requestHint(sessionId: string): Promise<HintResponse> {
  return callApi<HintResponse>(`/api/training/${sessionId}/hint`, { method: "POST" });
}

/** POST /api/training/:id/first-answer：提交首答，触发 1~2 轮 AI 追问（D7/BR-4） */
export async function submitFirstAnswer(
  sessionId: string,
  answer: string,
): Promise<FirstAnswerResponse> {
  const data = await callApi<FirstAnswerResponse>(`/api/training/${sessionId}/first-answer`, {
    method: "POST",
    body: JSON.stringify({ answer }),
  });
  return {
    ...data,
    firstAnswer: data.firstAnswer ?? answer,
    followups: normalizeFollowups(data.followups),
    // T35：闸门跳过标记兜底 false（空追问按失败态处理的旧行为仅保留给真失败）
    followupGateSkipped: data.followupGateSkipped === true,
  };
}

/** POST /api/training/:id/final-answer：提交终答（幂等；scored 由 T06 评分后写入） */
export async function submitFinalAnswer(
  sessionId: string,
  answer: string,
): Promise<FinalAnswerResponse> {
  const data = await callApi<FinalAnswerResponse>(`/api/training/${sessionId}/final-answer`, {
    method: "POST",
    body: JSON.stringify({ answer }),
  });
  return { ...data, finalAnswer: data.finalAnswer ?? answer };
}

/** POST /api/training/:id/followup-hint：释放某轮追问的预生成提示（T19 / D22，幂等） */
export async function requestFollowupHint(
  sessionId: string,
  round: number,
): Promise<FollowupHintResponse> {
  return callApi<FollowupHintResponse>(`/api/training/${sessionId}/followup-hint`, {
    method: "POST",
    body: JSON.stringify({ round }),
  });
}

/**
 * POST /api/training/:id/followup-retry（T37 / D39）：追问生成失败后的用户侧重试。
 * 幂等：已有追问直接返回既有，不重复调 AI；再次失败返回空 followups，调用方按失败态处理。
 */
export async function retryFollowups(sessionId: string): Promise<FollowupRetryResponse> {
  const data = await callApi<FollowupRetryResponse>(`/api/training/${sessionId}/followup-retry`, {
    method: "POST",
  });
  return {
    ...data,
    followups: normalizeFollowups(data.followups),
    followupGateSkipped: data.followupGateSkipped === true,
  };
}

/** POST /api/training/extra：创建/复用加练会话（T21 / D3），返回 { sessionId }（T25：调用方拿 sessionId 直达新工作台） */
export async function startExtraSession(): Promise<ExtraSessionResponse> {
  return callApi<ExtraSessionResponse>("/api/training/extra", { method: "POST" });
}

/**
 * POST /api/training/:id/abandon（T38 / D40）：终止当前会话（两步确认后调用，幂等）。
 * 409 分支由调用方按 code 处理：BASELINE_SESSION / FINAL_ANSWER_ALREADY_SUBMITTED /
 * SESSION_ALREADY_SCORED；429 RATE_LIMITED。
 */
export async function abandonSession(sessionId: string): Promise<AbandonSessionResponse> {
  return callApi<AbandonSessionResponse>(`/api/training/${sessionId}/abandon`, {
    method: "POST",
  });
}
