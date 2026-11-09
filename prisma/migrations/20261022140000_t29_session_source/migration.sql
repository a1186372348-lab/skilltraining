-- T29 / D32（P3 公共前置）：TrainingSession 新增 sourceType（枚举）+ sourceId（可空），
-- 并按 question.kind 与 is_extra 回填历史数据（回填只写新列，幂等可重跑）。
-- 同一 SQL 同时存在于 scripts/lib/backfill-session-source.ts（供集成测试与手工重跑调用）——
-- 任一方变更必须同步另一方。

-- CreateEnum
CREATE TYPE "TrainingSessionSource" AS ENUM ('daily', 'extra', 'baseline', 'plan', 'pack', 'retest');

-- AlterTable
ALTER TABLE "training_sessions" ADD COLUMN "source_id" UUID,
ADD COLUMN "source_type" "TrainingSessionSource" NOT NULL DEFAULT 'daily';

-- 历史数据回填（幂等守卫：已正确的行不重写）：
-- question.kind = baseline → baseline（优先于 isExtra）；is_extra → extra；其余 → daily。
UPDATE "training_sessions" AS s
SET "source_type" = CASE
    WHEN q."kind" = 'baseline' THEN 'baseline'::"TrainingSessionSource"
    WHEN s."is_extra" THEN 'extra'::"TrainingSessionSource"
    ELSE 'daily'::"TrainingSessionSource"
  END
FROM "questions" AS q
WHERE s."question_id" = q."id"
  AND s."source_type" IS DISTINCT FROM CASE
    WHEN q."kind" = 'baseline' THEN 'baseline'::"TrainingSessionSource"
    WHEN s."is_extra" THEN 'extra'::"TrainingSessionSource"
    ELSE 'daily'::"TrainingSessionSource"
  END;
