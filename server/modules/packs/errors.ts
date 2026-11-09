export const PACK_ERROR_CODES = {
  INVALID_DIMENSION: "INVALID_DIMENSION",
  INSUFFICIENT_QUESTIONS: "INSUFFICIENT_QUESTIONS",
  ACTIVE_PACK_EXISTS: "ACTIVE_PACK_EXISTS",
  PACK_NOT_FOUND: "PACK_NOT_FOUND",
  PACK_NOT_ACTIVE: "PACK_NOT_ACTIVE",
  ITEM_LOCKED: "ITEM_LOCKED",
  ITEM_INCONSISTENT: "ITEM_INCONSISTENT",
  SESSION_IN_PROGRESS: "SESSION_IN_PROGRESS",
  QUESTION_UNAVAILABLE: "QUESTION_UNAVAILABLE",
  BASELINE_REQUIRED: "BASELINE_REQUIRED",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
} as const;

export type PackErrorCode = (typeof PACK_ERROR_CODES)[keyof typeof PACK_ERROR_CODES];

export class PackError extends Error {
  constructor(
    public readonly code: PackErrorCode,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "PackError";
  }
}
