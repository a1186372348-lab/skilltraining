/**
 * 基线测评模块业务错误：携带错误码与 HTTP 状态，路由层统一映射为 jsonError。
 * 约定与 selection/errors.ts 一致。
 */
export class BaselineError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "BaselineError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 基线模块错误码（路由层据此外发，前端可按 code 分支处理） */
export const BASELINE_ERROR_CODES = {
  BASELINE_NOT_REQUIRED: "BASELINE_NOT_REQUIRED", // 基线已完成或题库暂无基线题
  BASELINE_SCORING_PENDING: "BASELINE_SCORING_PENDING", // 基线全部已作答、评分生成中（T36 / D38：中途不得落入日常训练）
  BASELINE_REQUIRED: "BASELINE_REQUIRED", // 基线未完成，须先完成基线测评（T36 / D38：加练等日常入口门禁，前端挡回 /baseline）
} as const;
