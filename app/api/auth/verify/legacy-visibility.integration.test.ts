import { randomBytes, randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { GET as getAbility } from "@/app/api/profile/ability/route";
import { GET as getToday } from "@/app/api/training/today/route";
import { setAuthServiceForTests } from "@/server/modules/auth";
import { resetAuthRateLimitersForTests } from "@/server/modules/auth/guards";
import { PrismaAuthRepository } from "@/server/modules/auth/repository";
import { AuthService } from "@/server/modules/auth/service";
import { generateMagicLinkToken } from "@/server/modules/auth/token";
import { getBaselineStatus } from "@/server/modules/baseline/service";
import { refreshAbilityProfile } from "@/server/modules/profile/ability";
import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";
import { scoreSession } from "@/server/modules/scoring/service";

import { GET as verifyLogin } from "./route";

const db = new PrismaClient();
const createdQuestionIds: string[] = [];
const createdUserIds: string[] = [];
let previouslyPublishedBaselineIds: string[] = [];

beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", randomBytes(32).toString("hex"));
  previouslyPublishedBaselineIds = (await db.question.findMany({
    where: { kind: "baseline", status: "published" }, select: { id: true },
  })).map(({ id }) => id);
  await db.question.updateMany({
    where: { id: { in: previouslyPublishedBaselineIds } }, data: { status: "archived" },
  });
});

afterAll(async () => {
  setAuthServiceForTests(null);
  vi.unstubAllEnvs();
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await db.question.deleteMany({ where: { id: { in: createdQuestionIds } } });
  await db.question.updateMany({
    where: { id: { in: previouslyPublishedBaselineIds } }, data: { status: "published" },
  });
  await db.$disconnect();
});

async function makeQuestion(kind: "baseline" | "daily", dimension: string) {
  const question = await db.question.create({ data: {
    id: randomUUID(), kind, status: "published", caseTitle: "合成测试题",
    caseBackground: {}, mainQuestion: "如何验证判断？", abilityTags: [dimension], difficulty: 1,
    rubric: { dimensions: { [dimension]: ["提供证据"] } }, hintTree: [], materials: {},
  } });
  createdQuestionIds.push(question.id);
  return question;
}

function request(path: string, cookie: string): Request {
  return new Request(`http://localhost:3000${path}`, { headers: { cookie } });
}

it("旧用户登录后遵循原基线流程，开始后暂隐并在实际完成后揭晓", async () => {
  const repo = new PrismaAuthRepository(db);
  const { user, identity } = await repo.createUserWithIdentity(`legacy-flow-${randomUUID()}@example.com`);
  createdUserIds.push(user.id);
  await db.userProfile.create({ data: {
    userId: user.id, position: "产品经理", yearsExperience: "1-3年", industry: "软件",
    familiarProducts: [], interestAreas: [], selfAssessment: {},
  } });
  const daily = await makeQuestion("daily", "用户理解");
  const old = await db.trainingSession.create({ data: {
    userId: user.id, questionId: daily.id, date: new Date("2025-01-01T00:00:00Z"),
    state: "scored", finalAnswer: "历史合成回答", finalSubmittedAt: new Date(), scoredAt: new Date(),
  } });
  await db.score.create({ data: {
    sessionId: old.id, dimension: "用户理解", rawScore: 74, hintCount: 0,
    coefficient: 1, effectiveScore: 74,
  } });
  await refreshAbilityProfile(db, user.id, ["用户理解"]);
  for (const dimension of ABILITY_DIMENSIONS) await makeQuestion("baseline", dimension);

  setAuthServiceForTests(new AuthService({
    repo, baseUrl: "http://localhost:3000",
    mailer: { sendMagicLink: async () => { throw new Error("测试禁止发送邮件"); } },
  }));
  resetAuthRateLimitersForTests();
  const token = generateMagicLinkToken();
  await repo.createMagicLinkToken({ identityId: identity.id, tokenHash: token.tokenHash, expiresAt: token.expiresAt });
  const login = await verifyLogin(new NextRequest(`http://localhost:3000/api/auth/verify?token=${token.token}`));
  expect(login.status).toBe(307);
  expect(new URL(login.headers.get("location")!).pathname).toBe("/baseline");
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  expect((await getAbility(request("/api/profile/ability", cookie))).status).toBe(200);

  for (let i = 0; i < ABILITY_DIMENSIONS.length; i++) {
    const today = await getToday(request("/api/training/today", cookie));
    expect(today.status).toBe(200);
    const body = await today.json();
    expect(body.data.kind).toBe("baseline");
    const blocked = await getAbility(request("/api/profile/ability", cookie));
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("BASELINE_REQUIRED");
    const session = await db.trainingSession.findUniqueOrThrow({
      where: { id: body.data.sessionId }, include: { question: true },
    });
    const dimension = (session.question.abilityTags as string[])[0];
    await db.trainingSession.update({ where: { id: session.id }, data: {
      state: "followup", finalAnswer: "合成最终回答", finalSubmittedAt: new Date(),
    } });
    await scoreSession(db, session.id, user.id, { scoreWithRubric: async () => ({
      dimensions: [{ dimension, rawScore: 70, diagnosis: "合成诊断" }],
      topIssue: "补充证据", nextFocus: "写出验证方法", confidence: 90,
    }) });
  }

  expect((await getAbility(request("/api/profile/ability", cookie))).status).toBe(409);
  const completed = await getBaselineStatus(db, user.id);
  expect(completed.required).toBe(false);
  expect(completed.completedAt).not.toBeNull();
  const revealed = await getAbility(request("/api/profile/ability", cookie));
  expect(revealed.status).toBe(200);
  const profile = await revealed.json();
  expect(profile.data.insight.observedCount).toBe(8);
  expect(profile.data.dimensions.find((d: { dimension: string }) => d.dimension === "用户理解").currentScore).toBe(72);
});
