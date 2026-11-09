export const STAGE_ERROR_CODES = {
  BASELINE_REQUIRED: "BASELINE_REQUIRED",
  STAGE_NOT_FOUND: "STAGE_NOT_FOUND",
  INVALID_DIMENSION: "INVALID_DIMENSION",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_ALREADY_SUBMITTED: "SESSION_ALREADY_SUBMITTED",
  STAGE_CORRUPT: "STAGE_CORRUPT",
} as const;

export class StageError extends Error {
  constructor(public readonly code: string, public readonly httpStatus: number, message: string) {
    super(message);
    this.name = "StageError";
  }
}
