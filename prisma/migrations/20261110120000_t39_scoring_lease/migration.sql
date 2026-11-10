ALTER TABLE "training_sessions"
  ADD COLUMN "scoring_lease_token" UUID,
  ADD COLUMN "scoring_lease_expires_at" TIMESTAMP(3);
