/**
 * 训练模块业务错误：携带错误码与 HTTP 状态，路由层统一映射为 jsonError。
 * message 面向开发者；对外响应由路由层按 code 给出不泄露内部细节的文案。
 */
export class TrainingError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "TrainingError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 训练模块错误码（路由层据此外发，前端可按 code 分支处理） */
export const TRAINING_ERROR_CODES = {
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND", // 会话不存在或不属于当前用户（不泄露存在性）
  NO_PUBLISHED_QUESTION: "NO_PUBLISHED_QUESTION", // 题库暂无上架题目
  HINT_DISABLED: "HINT_DISABLED", // 首次提交后提示永久禁用（D7）
  HINTS_EXHAUSTED: "HINTS_EXHAUSTED", // 5 层提示已全部释放（D5）
  FOLLOWUP_NOT_FOUND: "FOLLOWUP_NOT_FOUND", // 追问轮次不存在（D22）
  FOLLOWUP_HINT_NOT_AVAILABLE: "FOLLOWUP_HINT_NOT_AVAILABLE", // 该轮追问无预生成提示（AI 降级/存量老数据）
  FIRST_ANSWER_ALREADY_SUBMITTED: "FIRST_ANSWER_ALREADY_SUBMITTED",
  FIRST_ANSWER_REQUIRED: "FIRST_ANSWER_REQUIRED", // 未提交首答就提交终答
  SESSION_ALREADY_SCORED: "SESSION_ALREADY_SCORED",
  BASELINE_SESSION: "BASELINE_SESSION", // 基线测评会话进入日常工作台端点（T25：前端据此重定向 /baseline）
  INVALID_STATE: "INVALID_STATE", // 兜底：状态机不允许的迁移
} as const;
