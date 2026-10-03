-- CreateEnum
CREATE TYPE "TrainingSessionState" AS ENUM ('reading', 'answering', 'followup', 'scored');

-- CreateEnum
CREATE TYPE "QuestionStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_uid" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "magic_link_tokens" (
    "id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_ip" TEXT,

    CONSTRAINT "magic_link_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "user_id" UUID NOT NULL,
    "position" TEXT NOT NULL,
    "years_experience" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "project_experience" TEXT,
    "familiar_products" JSONB NOT NULL,
    "interest_areas" JSONB NOT NULL,
    "learning_goal" TEXT,
    "self_assessment" JSONB NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" UUID NOT NULL,
    "case_title" TEXT NOT NULL,
    "case_background" JSONB NOT NULL,
    "main_question" TEXT NOT NULL,
    "ability_tags" JSONB NOT NULL,
    "difficulty" INTEGER NOT NULL,
    "rubric" JSONB NOT NULL,
    "hint_tree" JSONB NOT NULL,
    "materials" JSONB NOT NULL,
    "status" "QuestionStatus" NOT NULL DEFAULT 'draft',

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "is_extra" BOOLEAN NOT NULL DEFAULT false,
    "state" "TrainingSessionState" NOT NULL DEFAULT 'reading',
    "first_answer" TEXT,
    "final_answer" TEXT,
    "hint_count" INTEGER NOT NULL DEFAULT 0,
    "followups" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "first_submitted_at" TIMESTAMP(3),
    "final_submitted_at" TIMESTAMP(3),
    "scored_at" TIMESTAMP(3),

    CONSTRAINT "training_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hint_events" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "layer" INTEGER NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hint_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scores" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "dimension" TEXT NOT NULL,
    "raw_score" DOUBLE PRECISION NOT NULL,
    "hint_count" INTEGER NOT NULL,
    "coefficient" DOUBLE PRECISION NOT NULL,
    "effective_score" DOUBLE PRECISION NOT NULL,
    "diagnosis_text" TEXT,

    CONSTRAINT "scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_feedback" (
    "session_id" UUID NOT NULL,
    "top_issue_text" TEXT NOT NULL,
    "next_focus_text" TEXT NOT NULL,

    CONSTRAINT "session_feedback_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "ability_profiles" (
    "user_id" UUID NOT NULL,
    "dimension" TEXT NOT NULL,
    "current_score" DOUBLE PRECISION,
    "observation_count" INTEGER NOT NULL DEFAULT 0,
    "hint_dependency" DOUBLE PRECISION,
    "trend" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ability_profiles_pkey" PRIMARY KEY ("user_id","dimension")
);

-- CreateTable
CREATE TABLE "feedback_surveys" (
    "session_id" UUID NOT NULL,
    "q1_clarity" INTEGER NOT NULL,
    "q2_next" INTEGER NOT NULL,
    "periodic_q3" INTEGER,

    CONSTRAINT "feedback_surveys_pkey" PRIMARY KEY ("session_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "auth_identities_user_id_idx" ON "auth_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identities_provider_provider_uid_key" ON "auth_identities"("provider", "provider_uid");

-- CreateIndex
CREATE UNIQUE INDEX "magic_link_tokens_token_hash_key" ON "magic_link_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "magic_link_tokens_identity_id_idx" ON "magic_link_tokens"("identity_id");

-- CreateIndex
CREATE INDEX "training_sessions_user_id_date_idx" ON "training_sessions"("user_id", "date");

-- CreateIndex
CREATE INDEX "training_sessions_question_id_idx" ON "training_sessions"("question_id");

-- CreateIndex
CREATE INDEX "hint_events_session_id_idx" ON "hint_events"("session_id");

-- CreateIndex
CREATE INDEX "scores_session_id_idx" ON "scores"("session_id");

-- AddForeignKey
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "magic_link_tokens" ADD CONSTRAINT "magic_link_tokens_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "auth_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hint_events" ADD CONSTRAINT "hint_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "training_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scores" ADD CONSTRAINT "scores_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "training_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_feedback" ADD CONSTRAINT "session_feedback_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "training_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ability_profiles" ADD CONSTRAINT "ability_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_surveys" ADD CONSTRAINT "feedback_surveys_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "training_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
