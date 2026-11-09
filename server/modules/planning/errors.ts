/**
 * 周期训练计划模块业务错误：携带错误码与 HTTP 状态，路由层统一映射为 jsonError。
 * 约定与 baseline/errors.ts 一致。
 */
export class PlanningError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "PlanningError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** planning 模块错误码（路由层据此外发，前端可按 code 分支处理） */
export const PLANNING_ERROR_CODES = {
  PLAN_CONFLICT: "PLAN_CONFLICT",
  PLAN_COMPLETED: "PLAN_COMPLETED",
  PLAN_NOT_FOUND: "PLAN_NOT_FOUND", // 本周尚无计划（懒生成前置失败或已过期）
  /** 存在未知维度（D35：未知维度不参与最低分排序，暂缓生成，提示先完成基线测评） */
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
} as const;
