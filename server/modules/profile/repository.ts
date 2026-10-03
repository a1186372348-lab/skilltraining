import type { PrismaClient, UserProfile } from "@prisma/client";

import {
  profileDraftSchema,
  type ProfileDraftInput,
  type ProfileSubmitInput,
} from "./schema";

/**
 * 初始用户画像的数据访问（user_profiles / profile_drafts）。
 * - upsertUserProfile：以 user_id 为主键 upsert，天然幂等，提交失败可直接重试；
 * - getFamiliarProducts：向出题模块（T11）暴露"熟悉产品"读取接口，
 *   供首题案例优先匹配（Prd.md D11）；
 * - 草稿三件套：暂存问卷快照，刷新不丢；提交成功后由服务端清除。
 */

export async function upsertUserProfile(
  db: PrismaClient,
  userId: string,
  input: ProfileSubmitInput,
): Promise<UserProfile> {
  const row = {
    position: input.position,
    yearsExperience: input.yearsExperience,
    industry: input.industry,
    projectExperience: input.projectExperience ?? null,
    familiarProducts: input.familiarProducts,
    interestAreas: input.interestAreas,
    learningGoal: input.learningGoal ?? null,
    selfAssessment: input.selfAssessment,
  };
  return db.userProfile.upsert({
    where: { userId },
    create: { userId, ...row },
    update: row,
  });
}

export async function getUserProfile(
  db: PrismaClient,
  userId: string,
): Promise<UserProfile | null> {
  return db.userProfile.findUnique({ where: { userId } });
}

/** T11 出题模块读取接口：返回用户熟悉的产品名列表（无画像时返回空数组） */
export async function getFamiliarProducts(
  db: PrismaClient,
  userId: string,
): Promise<string[]> {
  const row = await db.userProfile.findUnique({
    where: { userId },
    select: { familiarProducts: true },
  });
  if (!row || !Array.isArray(row.familiarProducts)) return [];
  // jsonb 为弱类型，防御历史脏数据：仅返回字符串项
  return row.familiarProducts.filter(
    (item): item is string => typeof item === "string",
  );
}

export async function saveProfileDraft(
  db: PrismaClient,
  userId: string,
  payload: ProfileDraftInput,
): Promise<void> {
  await db.profileDraft.upsert({
    where: { userId },
    create: { userId, payload },
    update: { payload },
  });
}

/** 读取草稿；库中内容无法通过草稿校验时按无草稿处理（防御脏数据） */
export async function getProfileDraft(
  db: PrismaClient,
  userId: string,
): Promise<ProfileDraftInput | null> {
  const row = await db.profileDraft.findUnique({ where: { userId } });
  if (!row) return null;
  const parsed = profileDraftSchema.safeParse(row.payload);
  return parsed.success ? parsed.data : null;
}

/** 清除草稿（提交成功后调用）；deleteMany 保证重复调用不报错 */
export async function deleteProfileDraft(
  db: PrismaClient,
  userId: string,
): Promise<void> {
  await db.profileDraft.deleteMany({ where: { userId } });
}
