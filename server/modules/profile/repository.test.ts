import { randomUUID } from "node:crypto";

import { PrismaClient, type User } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import {
  deleteProfileDraft,
  getFamiliarProducts,
  getProfileDraft,
  getUserProfile,
  saveProfileDraft,
  upsertUserProfile,
} from "./repository";
import type { ProfileSubmitInput } from "./schema";

// 集成测试：直连 docker 中的 PostgreSQL（端口 5433，见 .env / docker-compose.yml）。
// 每个用例使用独立的一次性用户，结束后级联清理，互不影响。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

async function createUser(): Promise<User> {
  const user = await prisma.user.create({
    data: { email: `t04-test-${randomUUID()}@example.com` },
  });
  createdUserIds.push(user.id);
  return user;
}

const sampleInput: ProfileSubmitInput = {
  position: "产品经理",
  yearsExperience: "1-3年",
  industry: "互联网/软件",
  projectExperience: "负责过一款工具类 App。",
  familiarProducts: ["飞书", "Notion"],
  interestAreas: ["AI 应用"],
  learningGoal: "提升方案设计能力",
  selfAssessment: ["问题定义", "方案设计"],
};

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("upsertUserProfile / getUserProfile", () => {
  it("首次写入创建画像，字段完整落库", async () => {
    const user = await createUser();
    const profile = await upsertUserProfile(prisma, user.id, sampleInput);

    expect(profile.userId).toBe(user.id);
    expect(profile.position).toBe("产品经理");
    expect(profile.familiarProducts).toEqual(["飞书", "Notion"]);
    expect(profile.selfAssessment).toEqual(["问题定义", "方案设计"]);

    const fetched = await getUserProfile(prisma, user.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.industry).toBe("互联网/软件");
  });

  it("重复提交幂等：相同输入多次 upsert 结果一致", async () => {
    const user = await createUser();
    const first = await upsertUserProfile(prisma, user.id, sampleInput);
    const second = await upsertUserProfile(prisma, user.id, sampleInput);

    expect(second).toEqual(first);
    expect(await prisma.userProfile.count({ where: { userId: user.id } })).toBe(
      1,
    );
  });

  it("变更输入后 upsert 覆盖旧值（可重试且以最新提交为准）", async () => {
    const user = await createUser();
    await upsertUserProfile(prisma, user.id, sampleInput);
    const updated = await upsertUserProfile(prisma, user.id, {
      ...sampleInput,
      industry: "教育",
      familiarProducts: ["微信"],
    });

    expect(updated.industry).toBe("教育");
    expect(updated.familiarProducts).toEqual(["微信"]);
  });

  it("未提交过画像时 getUserProfile 返回 null", async () => {
    const user = await createUser();
    expect(await getUserProfile(prisma, user.id)).toBeNull();
  });
});

describe("getFamiliarProducts（T11 出题模块读取接口，D11 首题优先匹配）", () => {
  it("返回画像中的熟悉产品列表", async () => {
    const user = await createUser();
    await upsertUserProfile(prisma, user.id, sampleInput);
    expect(await getFamiliarProducts(prisma, user.id)).toEqual([
      "飞书",
      "Notion",
    ]);
  });

  it("无画像时返回空数组，不抛错", async () => {
    const user = await createUser();
    expect(await getFamiliarProducts(prisma, user.id)).toEqual([]);
  });

  it("jsonb 中混入非字符串元素时过滤，仅返回字符串", async () => {
    const user = await createUser();
    await upsertUserProfile(prisma, user.id, sampleInput);
    // 模拟历史/异常数据：直接写库绕过校验
    await prisma.userProfile.update({
      where: { userId: user.id },
      data: { familiarProducts: ["飞书", 42, null, "Notion"] },
    });
    expect(await getFamiliarProducts(prisma, user.id)).toEqual([
      "飞书",
      "Notion",
    ]);
  });
});

describe("画像草稿暂存（刷新不丢，提交后清除）", () => {
  it("保存后可读取，覆盖写以最新为准", async () => {
    const user = await createUser();
    await saveProfileDraft(prisma, user.id, { position: "产品经理" });
    expect(await getProfileDraft(prisma, user.id)).toEqual({
      position: "产品经理",
    });

    await saveProfileDraft(prisma, user.id, {
      position: "项目经理",
      industry: "金融",
    });
    expect(await getProfileDraft(prisma, user.id)).toEqual({
      position: "项目经理",
      industry: "金融",
    });
  });

  it("无草稿时返回 null", async () => {
    const user = await createUser();
    expect(await getProfileDraft(prisma, user.id)).toBeNull();
  });

  it("库中草稿内容非法时按 null 处理（防御历史脏数据）", async () => {
    const user = await createUser();
    await prisma.profileDraft.create({
      data: { userId: user.id, payload: { position: 123 } },
    });
    expect(await getProfileDraft(prisma, user.id)).toBeNull();
  });

  it("删除幂等：存在时删除，不存在时不抛错", async () => {
    const user = await createUser();
    await saveProfileDraft(prisma, user.id, { position: "产品经理" });
    await deleteProfileDraft(prisma, user.id);
    expect(await getProfileDraft(prisma, user.id)).toBeNull();
    await expect(deleteProfileDraft(prisma, user.id)).resolves.toBeUndefined();
  });
});
