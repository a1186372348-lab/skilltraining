-- T31: 用户锁内评分序号与可恢复的阶段/复测事实；自定义索引和延迟外键不可省略。
BEGIN;
CREATE SEQUENCE "training_session_score_sequence" AS BIGINT INCREMENT 1 MINVALUE 1 NO CYCLE CACHE 1;
-- CreateEnum
CREATE TYPE "StageRecordType" AS ENUM ('retest_trigger', 'retest_pass', 'retest_fail');

-- CreateEnum
CREATE TYPE "RetestAttemptStatus" AS ENUM ('active', 'abandoned', 'settled');

-- AlterTable
ALTER TABLE "training_sessions" ADD COLUMN     "score_sequence" BIGINT,
ADD COLUMN     "scored_dimensions" JSONB;

-- CreateTable
CREATE TABLE "stage_progress" (
    "user_id" UUID NOT NULL,
    "dimension" TEXT NOT NULL,
    "initialized_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "legacy_window" JSONB NOT NULL,
    "after_sequence" BIGINT,

    CONSTRAINT "stage_progress_pkey" PRIMARY KEY ("user_id","dimension")
);

-- CreateTable
CREATE TABLE "stage_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "dimension" TEXT NOT NULL,
    "type" "StageRecordType" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event_score_sequence" BIGINT NOT NULL,
    "qualifying" JSONB,
    "settled_at" TIMESTAMPTZ(3),
    "trigger_id" UUID,
    "result_original_session_id" UUID,
    "result_effective_score" DOUBLE PRECISION,

    CONSTRAINT "stage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retest_attempts" (
    "id" UUID NOT NULL,
    "trigger_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "dimension" TEXT NOT NULL,
    "question_id" UUID NOT NULL,
    "session_id" UUID,
    "original_session_id" UUID NOT NULL,
    "status" "RetestAttemptStatus" NOT NULL DEFAULT 'active',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),

    CONSTRAINT "retest_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stage_records_trigger_id_key" ON "stage_records"("trigger_id");

-- CreateIndex
CREATE INDEX "stage_records_user_id_dimension_event_score_sequence_create_idx" ON "stage_records"("user_id", "dimension", "event_score_sequence", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "stage_records_id_user_id_dimension_key" ON "stage_records"("id", "user_id", "dimension");

-- CreateIndex
CREATE UNIQUE INDEX "retest_attempts_session_id_key" ON "retest_attempts"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "retest_attempts_original_session_id_key" ON "retest_attempts"("original_session_id");

-- CreateIndex
CREATE INDEX "retest_attempts_trigger_id_started_at_idx" ON "retest_attempts"("trigger_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "retest_attempts_user_id_question_id_key" ON "retest_attempts"("user_id", "question_id");

-- CreateIndex
CREATE UNIQUE INDEX "training_sessions_score_sequence_key" ON "training_sessions"("score_sequence");

-- CreateIndex
CREATE INDEX "training_sessions_user_id_score_sequence_idx" ON "training_sessions"("user_id", "score_sequence");

-- AddForeignKey
ALTER TABLE "stage_progress" ADD CONSTRAINT "stage_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_records" ADD CONSTRAINT "stage_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_records" ADD CONSTRAINT "stage_records_trigger_id_user_id_dimension_fkey" FOREIGN KEY ("trigger_id", "user_id", "dimension") REFERENCES "stage_records"("id", "user_id", "dimension") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "retest_attempts" ADD CONSTRAINT "retest_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retest_attempts" ADD CONSTRAINT "retest_attempts_trigger_id_user_id_dimension_fkey" FOREIGN KEY ("trigger_id", "user_id", "dimension") REFERENCES "stage_records"("id", "user_id", "dimension") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "retest_attempts" ADD CONSTRAINT "retest_attempts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "training_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_stage_scoring_metadata_check" CHECK (
  "score_sequence" IS NULL OR (
    "score_sequence" > 0 AND "scored_dimensions" IS NOT NULL AND
    jsonb_typeof("scored_dimensions") = 'array' AND "state" = 'scored' AND "scored_at" IS NOT NULL
  )
);

ALTER TABLE "stage_progress" ADD CONSTRAINT "stage_progress_boundary_check" CHECK (
  ("after_sequence" IS NULL OR "after_sequence" >= 0) AND
  CASE WHEN jsonb_typeof("legacy_window") = 'array' THEN jsonb_array_length("legacy_window") <= 3 ELSE false END
);

ALTER TABLE "stage_records" ADD CONSTRAINT "stage_records_event_check" CHECK (
  CASE WHEN "type" = 'retest_trigger' THEN
    "trigger_id" IS NULL AND "result_original_session_id" IS NULL AND "result_effective_score" IS NULL AND
    "event_score_sequence" >= 0 AND "qualifying" IS NOT NULL AND
    CASE WHEN jsonb_typeof("qualifying") = 'array' THEN jsonb_array_length("qualifying") = 3 ELSE false END
  ELSE
    "trigger_id" IS NOT NULL AND "result_original_session_id" IS NOT NULL AND "result_effective_score" IS NOT NULL AND
    "event_score_sequence" > 0 AND "qualifying" IS NULL AND "settled_at" IS NULL AND
    (("type" = 'retest_pass' AND "result_effective_score" >= 60 AND "result_effective_score" <= 100) OR
     ("type" = 'retest_fail' AND "result_effective_score" >= 0 AND "result_effective_score" < 60))
  END
);

ALTER TABLE "retest_attempts" ADD CONSTRAINT "retest_attempts_identity_check" CHECK (
  "session_id" IS NULL OR "session_id" = "original_session_id"
);
ALTER TABLE "retest_attempts" ADD CONSTRAINT "retest_attempts_terminal_check" CHECK (
  ("status" = 'active' AND "ended_at" IS NULL) OR
  ("status" IN ('abandoned', 'settled') AND "ended_at" IS NOT NULL)
);

CREATE UNIQUE INDEX "stage_records_one_pending_per_dimension_idx"
  ON "stage_records"("user_id", "dimension") WHERE "type" = 'retest_trigger' AND "settled_at" IS NULL;
CREATE UNIQUE INDEX "retest_attempts_one_active_per_trigger_idx"
  ON "retest_attempts"("trigger_id") WHERE "status" = 'active';
COMMIT;
