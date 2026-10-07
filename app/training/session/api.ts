import type {
  ExtraSessionResponse,
  FinalAnswerResponse,
  FirstAnswerResponse,
  FollowupHintResponse,
  FollowupRound,
  HintResponse,
  ReleasedHint,
  TodayView,
  TrainingSessionState,
} from "./contract";
import { coefficientForHintCount } from "./view-model";

/**
 * 今日训练 API 适配层（T05-Page）。
 *
 * ★★★ 联调接入点 ★★★
 * 服务端（app/api/training/*，T05 后端任务并行开发）就绪后：
 *   1. 将 USE_MOCK 置为 false（或删除 mock 分支与本文件中的 mock 代码）；
 *   2. 契约形状已与 server/modules/training 的测试草案对齐（见 app/training/session/contract.ts），
 *      若联调仍有出入，只需调整本文件的 normalize* 解析，页面组件不感知；
 *   3. 真实分支按统一响应封装 { success, data, error } 解析。
 * 页面组件只调用本文件的四个函数，不直接 fetch。
 */
const USE_MOCK = false;

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
export async function fetchTodaySession(): Promise<TodayView | null> {
  if (USE_MOCK) return mockFetchTodaySession();
  const data = await callApi<TodayView | null>("/api/training/today");
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
  if (USE_MOCK) return mockRequestHint(sessionId);
  return callApi<HintResponse>(`/api/training/${sessionId}/hint`, { method: "POST" });
}

/** POST /api/training/:id/first-answer：提交首答，触发 1~2 轮 AI 追问（D7/BR-4） */
export async function submitFirstAnswer(
  sessionId: string,
  answer: string,
): Promise<FirstAnswerResponse> {
  if (USE_MOCK) return mockSubmitFirstAnswer(sessionId, answer);
  const data = await callApi<FirstAnswerResponse>(`/api/training/${sessionId}/first-answer`, {
    method: "POST",
    body: JSON.stringify({ answer }),
  });
  return {
    ...data,
    firstAnswer: data.firstAnswer ?? answer,
    followups: normalizeFollowups(data.followups),
  };
}

/** POST /api/training/:id/final-answer：提交终答（幂等；scored 由 T06 评分后写入） */
export async function submitFinalAnswer(
  sessionId: string,
  answer: string,
): Promise<FinalAnswerResponse> {
  if (USE_MOCK) return mockSubmitFinalAnswer(sessionId, answer);
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
  if (USE_MOCK) return mockRequestFollowupHint(sessionId, round);
  return callApi<FollowupHintResponse>(`/api/training/${sessionId}/followup-hint`, {
    method: "POST",
    body: JSON.stringify({ round }),
  });
}

/** POST /api/training/extra：创建/复用加练会话（T21 / D3），返回 { sessionId }（T25：调用方拿 sessionId 直达新工作台） */
export async function startExtraSession(): Promise<ExtraSessionResponse> {
  return callApi<ExtraSessionResponse>("/api/training/extra", { method: "POST" });
}

/* ======================================================================
 * 以下为本地 mock 实现（USE_MOCK = true 时生效）。
 * 内容取自 content/questions/draft/Q01（Cursor Agent 模式），
 * 会话进度持久化在 localStorage，用于联调前演示"刷新按状态恢复"。
 * ====================================================================== */

const MOCK_STORAGE_KEY = "skilltraining.mock.today-session";
const MOCK_SESSION_ID = "mock-session-q01";

/** mock 提示树（5 层，对应 Q01 hint_tree） */
const MOCK_HINT_TREE: ReleasedHint[] = [
  {
    level: 1,
    stage: "任务澄清",
    question:
      "题目要你论证的是「为什么是质变」，而不是「Agent 能做什么」——你打算从用户侧、价值侧，还是两侧一起切入？你的结论句会长什么样？",
  },
  {
    level: 2,
    stage: "视角补充",
    question:
      "回忆你（或身边开发者）真实的一天开发工作：花在「敲字符」上的时间占多少？剩下的时间耗在哪些事上，那些事今天由谁完成？",
  },
  {
    level: 3,
    stage: "反例/风险",
    question:
      "如果「Agent 模式只是营销噱头」，反方最有力的证据是什么？一个代码库被 AI 自作主张改乱的开发者，会怎样评价这个功能？",
  },
  {
    level: 4,
    stage: "取舍权衡",
    question:
      "让 AI 自主改多个文件、跑命令，用户必然让渡了某种东西——是什么？如果你是设计师，会用什么机制把这种让渡控制在用户可接受的范围内？",
  },
  {
    level: 5,
    stage: "验证方式",
    question:
      "若要向团队证明「Agent 模式带来质变而非噱头」，你会追踪哪个指标的变化（而不是 Agent 功能使用率本身）？为什么是它？",
  },
];

/** mock 追问（对应服务端"首答后 AI 生成 1~2 轮追问"） */
const MOCK_FOLLOWUPS: FollowupRound[] = [
  {
    round: 1,
    question:
      "你说 Agent 接管了任务闭环——如果自主操作带来更高的错误风险，这个结论还成立吗？用户让渡的到底是什么？",
  },
  {
    round: 2,
    question:
      "你提到「省整块任务时间」。有证据吗？如果要向团队证明这不是噱头，你会看哪个指标？",
  },
];

/** mock 追问的预生成提示（T19 / D22：点击时读库零等待） */
const MOCK_FOLLOWUP_HINTS: Record<number, string> = {
  1: "先不急着维护结论——列出用户让渡清单：控制权、可预期性、出错时的排查成本，逐项对照「仍成立 / 需限定条件」。",
  2: "区分「功能使用率」与「任务完成时长」两类指标：想想哪类能直接反驳「噱头」，以及你会在哪个用户群体上观察它。",
};

/** mock 会话的可变部分（持久化到 localStorage 的最小状态） */
interface MockSessionStore {
  state: TrainingSessionState;
  releasedHints: ReleasedHint[];
  firstAnswer: string | null;
  finalAnswer: string | null;
  followups: FollowupRound[];
  /** 已释放追问提示的轮次（T19 / D22） */
  releasedFollowupHints: number[];
}

function initialMockStore(): MockSessionStore {
  return {
    state: "answering",
    releasedHints: [],
    firstAnswer: null,
    finalAnswer: null,
    followups: [],
    releasedFollowupHints: [],
  };
}

/** 读取 mock 会话（无则初始化；localStorage 不可用时退回内存态） */
let memoryStore: MockSessionStore | null = null;

const MOCK_STATES: readonly TrainingSessionState[] = [
  "reading",
  "answering",
  "followup",
  "scored",
];

/** 持久化数据形状校验：契约演进/手工改坏数据时回退初始态，不污染页面 */
function isValidMockStore(store: MockSessionStore): boolean {
  return (
    MOCK_STATES.includes(store.state) &&
    Array.isArray(store.releasedHints) &&
    Array.isArray(store.followups) &&
    store.followups.every(
      (round) =>
        round !== null &&
        typeof round === "object" &&
        typeof (round as { question?: unknown }).question === "string",
    )
  );
}

function loadMockStore(): MockSessionStore {
  try {
    const raw = window.localStorage.getItem(MOCK_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MockSessionStore;
      if (isValidMockStore(parsed)) {
        // T19 前持久化的旧数据无 releasedFollowupHints 字段：按空数组兜底
        if (!Array.isArray(parsed.releasedFollowupHints)) parsed.releasedFollowupHints = [];
        return parsed;
      }
    }
  } catch {
    // localStorage 不可用或数据损坏：退回内存态
  }
  if (!memoryStore) memoryStore = initialMockStore();
  return memoryStore;
}

function saveMockStore(store: MockSessionStore): void {
  memoryStore = store;
  try {
    window.localStorage.setItem(MOCK_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // 持久化失败不影响本次会话
  }
}

/** 组装完整负载：不可变题目内容 + 可变会话状态（扁平 today 视图） */
function buildMockPayload(store: MockSessionStore): TodayView {
  const hintCount = store.releasedHints.length;
  const followupHintCount = store.releasedFollowupHints.length;
  return {
    sessionId: MOCK_SESSION_ID,
    state: store.state,
    hintCount,
    followupHintCount,
    coefficient: coefficientForHintCount(hintCount, followupHintCount),
    canRequestHint:
      (store.state === "reading" || store.state === "answering") &&
      hintCount < MOCK_HINT_TREE.length,
    releasedHints: store.releasedHints,
    firstAnswer: store.firstAnswer,
    finalAnswer: store.finalAnswer,
    // T22：mock 不追踪首答提交时间，恒为 null（追问为空时按失败兜底）
    firstSubmittedAt: null,
    followups: store.followups.map((round) => {
      const released = store.releasedFollowupHints.includes(round.round);
      return {
        ...round,
        hasHint: round.round in MOCK_FOLLOWUP_HINTS,
        hintReleased: released,
        hint: released ? MOCK_FOLLOWUP_HINTS[round.round] : null,
      };
    }),
    caseTitle: "从「帮你写」到「替你做」：Cursor 的 Agent 模式",
    caseBackground: {
      product: {
        text: "Cursor——Anysphere 公司出品的 AI 原生代码编辑器，基于 VS Code 分叉构建，深度集成多家大模型。",
        citations: [1],
      },
      audience: {
        text: "软件开发者（从独立开发者到企业研发团队），尤其是愿意让 AI 深度参与开发流程的早期采用者。",
        citations: [1],
      },
      scenario: {
        text: "开发者完成一个真实编码任务的全过程：理解需求、定位代码、编写与修改多个文件、运行命令与测试、修复报错——而不只是在光标处续写下一行。",
        citations: [1, 2],
      },
      features: {
        text: "Tab 自动补全（多行连续补全）、Cmd+K 行内编辑、Chat/Ask 对话、Agent 模式（自主探索代码库、编辑多文件、运行终端命令）、Plan 模式、多 Agent 并行。",
        citations: [1, 2],
      },
      status: {
        text: "2025 年 Cursor 2.0 将编辑器重心转向多 Agent 管理（同一提示最多 8 个代理并行）；官方博客称用户主要工作正变为「为 Agent 提供完成任务所需的上下文」。",
        citations: [2],
      },
    },
    caseSources: [
      {
        id: 1,
        title: "使用智能体编码的最佳实践",
        publisher: "Cursor 官方博客",
        url: "https://cursor.com/cn/blog/agent-best-practices",
      },
      {
        id: 2,
        title: "全新代码模型与 Agent 界面（Cursor 2.0）",
        publisher: "Cursor 官网 Changelog",
        url: "https://cursor.com/cn/changelog/2-0",
      },
    ],
    mainQuestion:
      "以 Cursor 为例，从「代码补全」到「Agent 模式」的跨越，为什么是产品价值上的质变而不只是功能叠加？这一步跨越让产品付出了什么代价？",
    abilityTags: ["用户理解", "产品价值判断", "产品取舍"],
    materials: {
      core: [
        {
          title: "使用智能体编码的最佳实践",
          source: "Cursor 官方博客",
          url: "https://cursor.com/cn/blog/agent-best-practices",
          summary:
            "Cursor 官方谈 Agent 时代的用户角色：习惯由 Agent 写代码后，用户主要工作变为「为每个 Agent 提供完成任务所需的上下文」，可让 Agent 自行获取上下文。",
        },
        {
          title: "全新代码模型与 Agent 界面（Cursor 2.0）",
          source: "Cursor 官网 Changelog",
          url: "https://cursor.com/cn/changelog/2-0",
          summary:
            "Cursor 2.0 转向多 Agent 管理：侧边栏集中展示代理与计划，同一提示最多可并行运行八个代理，底层借助 git worktrees 或远程机器实现隔离。",
        },
      ],
      extended: [
        {
          title: "模式选对，效率翻倍：Cursor 的 3 种内置模式指南",
          source: "知乎专栏",
          url: "https://zhuanlan.zhihu.com/p/1899940397310018060",
          summary:
            "梳理 Cursor 内置模式差异：Agent 模式拥有全部工具权限，包括搜索代码库、编辑文件、运行终端命令等，适合新功能模块开发等复杂任务。",
        },
        {
          title: "Cursor 入门教程：三大核心 AI 功能",
          source: "SegmentFault",
          url: "https://segmentfault.com/a/1190000046916720",
          summary:
            "介绍 Tab 补全与 Chat 等核心功能；称 Agent 是默认且最自主的模式，可自主探索代码库、联网检索、编辑文件并运行终端命令，把复杂任务拆解后按序执行。",
        },
        {
          title: "免费 AI 编程助手实测对比：Copilot / Codeium / Cursor / Tabby",
          source: "盛网科技博客",
          url: "https://www.shengwang.cn/blog/blogdetail/free-ai-code-assistant/",
          summary:
            "对比文章指出 Cursor 基于 VS Code 分叉，核心为 Tab 补全与内置 Chat；用户测试中 Tab 的多行连续补全在连贯性与准确度上优于 GitHub Copilot。",
        },
      ],
    },
  };
}

/** 模拟网络延迟，让加载/提交态可被肉眼验证 */
function mockDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 300));
}

async function mockFetchTodaySession(): Promise<TodayView | null> {
  await mockDelay();
  return buildMockPayload(loadMockStore());
}

async function mockRequestHint(sessionId: string): Promise<HintResponse> {
  await mockDelay();
  if (sessionId !== MOCK_SESSION_ID) throw new Error("会话不存在或已过期");
  const store = loadMockStore();
  if (store.state !== "answering" && store.state !== "reading") {
    throw new Error("首次提交后不能再请求提示");
  }
  const nextHint = MOCK_HINT_TREE[store.releasedHints.length];
  if (!nextHint) throw new Error("5 层提示已全部释放");
  const updated: MockSessionStore = {
    ...store,
    state: "answering",
    releasedHints: [...store.releasedHints, nextHint],
  };
  saveMockStore(updated);
  const hintCount = updated.releasedHints.length;
  return {
    hint: nextHint,
    hintCount,
    coefficient: coefficientForHintCount(hintCount),
    state: "answering",
  };
}

async function mockSubmitFirstAnswer(
  sessionId: string,
  answer: string,
): Promise<FirstAnswerResponse> {
  await mockDelay();
  if (sessionId !== MOCK_SESSION_ID) throw new Error("会话不存在或已过期");
  const store = loadMockStore();
  if (store.state !== "answering" && store.state !== "reading") {
    throw new Error("当前状态不可提交首答");
  }
  const updated: MockSessionStore = {
    ...store,
    state: "followup",
    firstAnswer: answer,
    followups: MOCK_FOLLOWUPS,
  };
  saveMockStore(updated);
  return {
    state: "followup",
    firstAnswer: answer,
    followups: MOCK_FOLLOWUPS.map((round) => ({
      ...round,
      hasHint: round.round in MOCK_FOLLOWUP_HINTS,
      hintReleased: false,
      hint: null,
    })),
    coefficient: coefficientForHintCount(updated.releasedHints.length, 0),
  };
}

async function mockSubmitFinalAnswer(
  sessionId: string,
  answer: string,
): Promise<FinalAnswerResponse> {
  await mockDelay();
  if (sessionId !== MOCK_SESSION_ID) throw new Error("会话不存在或已过期");
  const store = loadMockStore();
  if (store.finalAnswer) {
    // 幂等：重复提交终答直接返回已落库内容
    return { state: store.state, finalAnswer: store.finalAnswer };
  }
  if (store.state !== "followup") throw new Error("当前状态不可提交终答");
  // 对齐 T05 服务端行为：终答落库后状态仍为 followup，scored 由 T06 评分写入
  saveMockStore({ ...store, finalAnswer: answer });
  return { state: "followup", finalAnswer: answer };
}

/** mock 释放追问提示：幂等（同一轮重复请求不重复计数），响应携带组合系数 */
async function mockRequestFollowupHint(
  sessionId: string,
  round: number,
): Promise<FollowupHintResponse> {
  await mockDelay();
  if (sessionId !== MOCK_SESSION_ID) throw new Error("会话不存在或已过期");
  const store = loadMockStore();
  if (store.state !== "followup") throw new Error("当前状态不可请求追问提示");
  const hint = MOCK_FOLLOWUP_HINTS[round];
  if (!store.followups.some((item) => item.round === round)) throw new Error("追问轮次不存在");
  if (!hint) throw new Error("该轮追问没有可用提示");
  const released = store.releasedFollowupHints.includes(round)
    ? store
    : { ...store, releasedFollowupHints: [...store.releasedFollowupHints, round] };
  if (released !== store) saveMockStore(released);
  return {
    round,
    hint,
    followupHintCount: released.releasedFollowupHints.length,
    coefficient: coefficientForHintCount(
      released.releasedHints.length,
      released.releasedFollowupHints.length,
    ),
  };
}
