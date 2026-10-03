import type { PrismaClient } from "@prisma/client";

import {
  getAbilityProfileView,
  type AbilityProfileDimensionView,
} from "@/server/modules/profile/ability";

import type { CandidateQuestion } from "./engine";

/**
 * 选题模块的数据访问（Repository 模式）：
 * 读 ability_profiles（经画像模块视图）、user_profiles、training_sessions、questions。
 * 接口与 Prisma 实现分离，服务层可注入 mock 仓储做单测与降级演练。
 */

/** 用户历史会话的出题视角（按 startedAt 倒序返回） */
export interface SessionHistoryItem {
  questionId: string;
  caseBackground: unknown;
}

export interface ProfilePreferences {
  familiarProducts: string[];
  interestAreas: string[];
}

export interface SelectionRepository {
  /** 全 8 维能力画像视图（未观测维度为未知态，BR-6/FR-8） */
  getProfileView(userId: string): Promise<AbilityProfileDimensionView[]>;
  /** 初始画像中的熟悉产品与兴趣领域（D11 / 图 2 H 节点） */
  getProfilePreferences(userId: string): Promise<ProfilePreferences>;
  /** 全部上架题（R3：仅 published 参与出题），按 id 升序保证稳定顺序 */
  listPublishedQuestions(): Promise<CandidateQuestion[]>;
  /** 用户历史会话（倒序），供已练过滤、近期同类案例与首次训练判定 */
  listSessionHistory(userId: string): Promise<SessionHistoryItem[]>;
}

/** 解析 jsonb 字符串数组字段（防御历史脏数据：仅保留字符串项） */
function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

/** Prisma 实现：生产路径唯一数据入口 */
export function createPrismaSelectionRepository(db: PrismaClient): SelectionRepository {
  return {
    async getProfileView(userId) {
      // 复用画像模块的全 8 维视图（未知维度补齐未知态）
      return getAbilityProfileView(db, userId);
    },
    async getProfilePreferences(userId) {
      const row = await db.userProfile.findUnique({
        where: { userId },
        select: { familiarProducts: true, interestAreas: true },
      });
      return {
        familiarProducts: parseStringArray(row?.familiarProducts),
        interestAreas: parseStringArray(row?.interestAreas),
      };
    },
    async listPublishedQuestions() {
      return db.question.findMany({
        where: { status: "published" },
        orderBy: { id: "asc" },
      });
    },
    async listSessionHistory(userId) {
      const sessions = await db.trainingSession.findMany({
        where: { userId },
        orderBy: { startedAt: "desc" },
        select: { questionId: true, question: { select: { caseBackground: true } } },
      });
      return sessions.map((session) => ({
        questionId: session.questionId,
        caseBackground: session.question.caseBackground,
      }));
    },
  };
}
