/**
 * 今日训练 API 契约（前端视角，T05-Page）。
 *
 * 已与 T05 后端任务的测试草案（server/modules/training/today-view.test.ts、
 * service.test.ts）对齐：
 * - today 视图为扁平结构（sessionId / state / coefficient / canRequestHint …）；
 * - followups 为 { round, question }[]（仅 AI 总监的追问轮次，用户回应即终答）；
 * - 终答提交后状态仍可能是 followup（scored 由 T06 写入），前端以 finalAnswer 判定完成；
 * - caseBackground 按 DB jsonb 下发（T13 新结构 {text, citations[]}，见 import-questions.ts）；
 * - caseSources 为服务端从 case_background jsonb 拆出的案例来源列表（T13 / BR-8）。
 * 统一响应封装沿用 server/lib/api-response.ts：{ success: true, data } / { success: false, error }。
 * 若联调时服务端字段有出入，只需修改本文件与 app/today/api.ts 的解析，页面组件不感知。
 */

/** 训练会话状态机（与 prisma TrainingSessionState 枚举一一对应） */
export type TrainingSessionState = "reading" | "answering" | "followup" | "scored";

/** 案例背景单字段（T13 / BR-8 新结构：事实文本 + 引用编号，编号指向 caseSources） */
export interface CaseBackgroundField {
  text: string;
  citations: number[];
}

/**
 * 案例背景五字段（T13 新契约键名 product/audience/scenario/features/status）。
 * 向后兼容：开发库已归档种子题的会话为旧版字符串形（含 related_features /
 * current_status 旧键），视图模型对两形并存做归一解析，页面不感知。
 */
export type CaseBackgroundFieldValue = string | CaseBackgroundField;

export interface CaseBackground {
  /** 产品 */
  product?: CaseBackgroundFieldValue;
  /** 服务谁 */
  audience?: CaseBackgroundFieldValue;
  /** 场景 */
  scenario?: CaseBackgroundFieldValue;
  /** 相关功能 */
  features?: CaseBackgroundFieldValue;
  /** 当前状态 */
  status?: CaseBackgroundFieldValue;
  /** 旧版键：相关功能（归档会话） */
  related_features?: string;
  /** 旧版键：当前状态（归档会话） */
  current_status?: string;
}

/** 案例来源条目（T13 / BR-8：字段引用编号 [n] 对应的出处，真实权威链接） */
export interface CaseSource {
  id: number;
  title: string;
  publisher: string;
  url: string;
}

/** 资料条目（D9：站内精编摘要 + 原文链接） */
export interface Material {
  title: string;
  source: string;
  url: string;
  /** 精编摘要 */
  summary: string;
}

/** 已释放的提示层（FR-10：未释放层绝不下发，故前端只有这个结构） */
export interface ReleasedHint {
  /** 层级 1~5 */
  level: number;
  /** 阶段名（如 任务澄清 / 视角补充） */
  stage: string;
  /** 提示文案（以提问形式引导思考） */
  question: string;
}

/** 追问记录（training_sessions.followups jsonb；追问不扣分，BR-4；用户对追问的回应即终答） */
export interface FollowupRound {
  /** 第几轮（1~2） */
  round: number;
  /** 总监的追问内容 */
  question: string;
}

/**
 * GET /api/training/today 的 data 负载（扁平 today 视图）；今日无可用会话时 data 为 null。
 * FR-10 出口防线：该视图绝不携带 Rubric、未释放提示层与评分 prompt。
 */
export interface TodayView {
  sessionId: string;
  state: TrainingSessionState;
  /** 首次提交前的提示次数（服务端记录为准，BR-3） */
  hintCount: number;
  /** 当前独立完成系数（BR-2，服务端权威值；前端仅展示） */
  coefficient: number;
  /** 是否还能请求提示（D7 + 5 层上限，服务端判定） */
  canRequestHint: boolean;
  /** 已释放提示层（刷新恢复用） */
  releasedHints: ReleasedHint[];
  firstAnswer: string | null;
  finalAnswer: string | null;
  /** AI 追问记录（首答后生成 1~2 轮；追问生成失败时为空，可直达终答） */
  followups: FollowupRound[];
  caseTitle: string;
  caseBackground: CaseBackground;
  /** 案例来源列表（T13 / BR-8：服务端从 case_background jsonb 拆出；旧版会话为空） */
  caseSources: CaseSource[];
  mainQuestion: string;
  /** 能力标签 2~4 个（训练重点卡的依据） */
  abilityTags: string[];
  materials: {
    /** 核心资料恰好 2 篇 */
    core: Material[];
    /** 扩展资料恰好 3 篇 */
    extended: Material[];
  };
}

/** POST /api/training/:id/hint 的 data 负载（FR-3：携带当前系数） */
export interface HintResponse {
  /** 本次释放的提示层 */
  hint: ReleasedHint;
  hintCount: number;
  coefficient: number;
  /** 固定推进到 answering */
  state: TrainingSessionState;
}

/** POST /api/training/:id/first-answer 的 data 负载（D7：此后提示入口永久关闭） */
export interface FirstAnswerResponse {
  /** 固定推进到 followup */
  state: TrainingSessionState;
  firstAnswer: string;
  /** AI 追问 1~2 轮；AI 失败时为空数组（回滚策略：可跳过追问直达终答） */
  followups: FollowupRound[];
  coefficient: number;
}

/** POST /api/training/:id/final-answer 的 data 负载（幂等：重复提交不覆盖不重复计分） */
export interface FinalAnswerResponse {
  /** 注意：T05 阶段终答后状态仍为 followup，scored 由 T06 评分后写入 */
  state: TrainingSessionState;
  finalAnswer: string;
}
