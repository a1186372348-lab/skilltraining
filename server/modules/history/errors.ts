/**
 * 历史模块业务错误：携带错误码与 HTTP 状态，路由层统一映射为 jsonError。
 * message 面向开发者；对外响应由路由层按 code 给出不泄露内部细节的文案。
 */
export class HistoryError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "HistoryError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 历史模块错误码（路由层据此外发） */
export const HISTORY_ERROR_CODES = {
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND", // 会话不存在或不属于当前用户（不泄露存在性）
} as const;
