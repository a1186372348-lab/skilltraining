/**
 * 评分模块业务错误：携带错误码与 HTTP 状态，路由层统一映射为 jsonError。
 * message 面向开发者；对外响应由路由层按 code 给出不泄露内部细节的文案。
 */
export class ScoringError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "ScoringError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 评分模块错误码（路由层据此外发，前端可按 code 分支处理） */
export const SCORING_ERROR_CODES = {
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND", // 会话不存在或不属于当前用户（不泄露存在性）
  SESSION_STATE_INVALID: "SESSION_STATE_INVALID", // 作答流程未走完，状态机不允许评分
  FINAL_ANSWER_REQUIRED: "FINAL_ANSWER_REQUIRED", // 未提交终答就触发评分
  QUESTION_RUBRIC_INVALID: "QUESTION_RUBRIC_INVALID", // 题目 Rubric 与能力标签不匹配（数据异常兜底）
  SCORING_OUTPUT_INVALID: "SCORING_OUTPUT_INVALID", // AI 评分输出解析/校验失败（可安全重试）
} as const;
