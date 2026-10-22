-- T28 / D31 切片 1：prompt 版本注册表与调优回归留档（两张全新表，反向迁移 = drop，不影响既有表）

-- CreateTable
CREATE TABLE "prompt_versions" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_runs" (
    "id" UUID NOT NULL,
    "prompt_version_id" UUID NOT NULL,
    "consistency_score" DOUBLE PRECISION,
    "report" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prompt_versions_name_version_key" ON "prompt_versions"("name", "version");

-- CreateIndex
CREATE INDEX "prompt_versions_name_status_idx" ON "prompt_versions"("name", "status");

-- CreateIndex
CREATE INDEX "eval_runs_prompt_version_id_idx" ON "eval_runs"("prompt_version_id");

-- AddForeignKey
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_prompt_version_id_fkey" FOREIGN KEY ("prompt_version_id") REFERENCES "prompt_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
