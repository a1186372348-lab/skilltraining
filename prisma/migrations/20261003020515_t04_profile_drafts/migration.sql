-- CreateTable
CREATE TABLE "profile_drafts" (
    "user_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profile_drafts_pkey" PRIMARY KEY ("user_id")
);

-- AddForeignKey
ALTER TABLE "profile_drafts" ADD CONSTRAINT "profile_drafts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
