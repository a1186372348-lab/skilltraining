-- T30 专项训练包；部分唯一索引与可延迟外键须在后续迁移中保留。
BEGIN;
CREATE TYPE "TrainingPackStatus" AS ENUM ('active', 'completed', 'abandoned');
CREATE TYPE "PackTier" AS ENUM ('basic', 'advanced', 'challenge');

CREATE TABLE "training_packs" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "dimension" TEXT NOT NULL,
  "status" "TrainingPackStatus" NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMP(3),
  CONSTRAINT "training_packs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_packs_terminal_time_check" CHECK (
    ("status" = 'active' AND "ended_at" IS NULL) OR
    ("status" IN ('completed', 'abandoned') AND "ended_at" IS NOT NULL)
  )
);

CREATE TABLE "pack_items" (
  "id" UUID NOT NULL,
  "pack_id" UUID NOT NULL,
  "question_id" UUID NOT NULL,
  "order_index" INTEGER NOT NULL,
  "target_tier" "PackTier" NOT NULL,
  "actual_tier" "PackTier" NOT NULL,
  "actual_difficulty" INTEGER NOT NULL,
  "unlocked_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "session_id" UUID,
  CONSTRAINT "pack_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pack_items_order_tier_check" CHECK (
    ("order_index" IN (0, 1) AND "target_tier" = 'basic') OR
    ("order_index" IN (2, 3) AND "target_tier" = 'advanced') OR
    ("order_index" = 4 AND "target_tier" = 'challenge')
  ),
  CONSTRAINT "pack_items_actual_tier_check" CHECK (
    ("actual_difficulty" BETWEEN 1 AND 2 AND "actual_tier" = 'basic') OR
    ("actual_difficulty" = 3 AND "actual_tier" = 'advanced') OR
    ("actual_difficulty" BETWEEN 4 AND 5 AND "actual_tier" = 'challenge')
  ),
  CONSTRAINT "pack_items_started_session_check" CHECK ("session_id" IS NULL OR "started_at" IS NOT NULL),
  CONSTRAINT "pack_items_unlocked_started_check" CHECK ("started_at" IS NULL OR "unlocked_at" IS NOT NULL)
);

ALTER TABLE "training_sessions" ADD COLUMN "linked_plan_id" UUID;

CREATE INDEX "training_packs_user_id_status_idx" ON "training_packs"("user_id", "status");
CREATE UNIQUE INDEX "training_packs_one_active_per_user_idx" ON "training_packs"("user_id") WHERE "status" = 'active';
CREATE UNIQUE INDEX "pack_items_pack_id_order_index_key" ON "pack_items"("pack_id", "order_index");
CREATE UNIQUE INDEX "pack_items_pack_id_question_id_key" ON "pack_items"("pack_id", "question_id");
CREATE UNIQUE INDEX "pack_items_session_id_key" ON "pack_items"("session_id");
CREATE INDEX "pack_items_question_id_idx" ON "pack_items"("question_id");
CREATE INDEX "training_sessions_linked_plan_id_scored_at_idx" ON "training_sessions"("linked_plan_id", "scored_at");

ALTER TABLE "training_packs" ADD CONSTRAINT "training_packs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "training_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "training_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_linked_plan_id_fkey" FOREIGN KEY ("linked_plan_id") REFERENCES "training_plans"("id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

COMMIT;
