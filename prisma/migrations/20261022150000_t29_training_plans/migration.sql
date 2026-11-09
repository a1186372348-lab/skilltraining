-- T29 / F5：周期训练计划表（additive：新枚举 + 新表，不动既有表）
-- @@unique(user_id, week_start_date) 保证懒生成幂等（并发首访不双写）。

-- CreateEnum
CREATE TYPE "TrainingPlanStatus" AS ENUM ('active', 'rejected', 'completed');

-- CreateTable
CREATE TABLE "training_plans" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "week_start_date" DATE NOT NULL,
    "focus_dimension" TEXT NOT NULL,
    "start_score" DOUBLE PRECISION NOT NULL,
    "target_score" DOUBLE PRECISION NOT NULL,
    "status" "TrainingPlanStatus" NOT NULL DEFAULT 'active',
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "training_plans_user_id_week_start_date_key" ON "training_plans"("user_id", "week_start_date");

-- CreateIndex
CREATE INDEX "training_plans_user_id_status_idx" ON "training_plans"("user_id", "status");

-- AddForeignKey
ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
