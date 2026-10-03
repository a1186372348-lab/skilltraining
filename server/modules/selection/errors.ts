/**
 * 选题模块业务错误：携带错误码与 HTTP 状态，路由层统一映射为 jsonError。
 * 约定与 training/errors.ts 一致。
 */
export class SelectionError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "SelectionError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 选题模块错误码（路由层据此外发，前端可按 code 分支处理） */
export const SELECTION_ERROR_CODES = {
  NO_PUBLISHED_QUESTION: "NO_PUBLISHED_QUESTION", // 题库暂无上架题目
} as const;
