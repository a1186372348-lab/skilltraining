-- CreateEnum
CREATE TYPE "QuestionKind" AS ENUM ('baseline', 'daily');

-- AlterTable
ALTER TABLE "questions" ADD COLUMN     "kind" "QuestionKind" NOT NULL DEFAULT 'daily';

-- AlterTable
ALTER TABLE "user_profiles" ADD COLUMN     "baseline_completed_at" TIMESTAMP(3);
