-- AlterEnum
-- T38 / D40：训练终止与重启——会话新增 abandoned 状态（终止不删除，历史保留）
ALTER TYPE "TrainingSessionState" ADD VALUE 'abandoned';
