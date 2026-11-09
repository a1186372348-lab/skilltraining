-- T28 / D31 步骤 5：Score +confidence（评分置信度 0~100 可空；老数据 NULL，回滚 = drop column 无损）

-- AlterTable
ALTER TABLE "scores" ADD COLUMN "confidence" INTEGER;
