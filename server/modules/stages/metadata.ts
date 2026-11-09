import { z } from "zod";
import type { UserTransaction } from "@/server/lib/user-transaction";
import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";
import { STAGE_ERROR_CODES, StageError } from "./errors";

const dimensionsSchema = z.array(z.enum(ABILITY_DIMENSIONS)).min(1).max(ABILITY_DIMENSIONS.length)
  .refine(values => new Set(values).size === values.length);

export function validScoredDimensions(value: unknown): string[] | null {
  const parsed = dimensionsSchema.safeParse(value);
  return parsed.success ? [...parsed.data] : null;
}

/** 仅持本人 user 锁且正在提交评分的事务可调用；调用者必须同事务写入返回元数据及评分事实。 */
export async function nextScoringMetadataInTransaction(context: UserTransaction, dimensions: readonly string[]): Promise<{
  scoreSequence: bigint; scoredDimensions: string[];
}> {
  const scoredDimensions = validScoredDimensions(dimensions);
  if (!scoredDimensions) throw new StageError(STAGE_ERROR_CODES.INVALID_DIMENSION, 400, "评分维度无效");
  const rows = await context.tx.$queryRaw<{ value: bigint }[]>`SELECT nextval('training_session_score_sequence') AS value`;
  if (rows.length !== 1 || typeof rows[0].value !== "bigint" || rows[0].value <= BigInt(0)) {
    throw new StageError(STAGE_ERROR_CODES.STAGE_CORRUPT, 500, "评分顺序不可用");
  }
  return { scoreSequence: rows[0].value, scoredDimensions };
}
