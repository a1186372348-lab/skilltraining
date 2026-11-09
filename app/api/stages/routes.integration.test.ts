import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "@/app/api/_test/session";
import { withUserTransaction } from "@/server/lib/user-transaction";
import { nextScoringMetadataInTransaction } from "@/server/modules/stages";
import { GET } from "./overview/route";
import { POST } from "./retest/start/route";

const db = new PrismaClient();
const userIds: string[] = [];
const questionIds: string[] = [];
const dimension = "问题定义";

async function account(completed: boolean) {
  const row = await db.user.create({ data: { email: `t31-api-${randomUUID()}@example.com`, profile: { create: {
    position: "测试", yearsExperience: "1", industry: "测试", familiarProducts: [], interestAreas: [], selfAssessment: {},
    baselineCompletedAt: completed ? new Date() : null,
  } } } });
  userIds.push(row.id);
  return row;
}

async function question() {
  const row = await db.question.create({ data: {
    caseTitle: "合成题", caseBackground: {}, mainQuestion: "不能从阶段返回的题面", abilityTags: [dimension], difficulty: 2,
    rubric: { dimensions: { [dimension]: ["不能泄露的标准"] } }, hintTree: [], materials: {}, status: "published", kind: "daily",
  } });
  questionIds.push(row.id);
  return row;
}

function request(user: { id: string; email: string } | null, body?: unknown) {
  return new Request("http://localhost/api/stages", {
    method: body === undefined ? "GET" : "POST", headers: user ? { cookie: sessionCookieHeader(user) } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  const [row] = await db.$queryRaw<{ database: string; schema: string }[]>`SELECT current_database() AS database, current_schema() AS schema`;
  if (row.database !== "skilltraining_test" || !/^v2_core_20261103_[a-f0-9]{12}$/.test(row.schema)) throw new Error("隔离测试库身份不匹配");
});
afterEach(async () => {
  await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  await db.question.deleteMany({ where: { id: { in: questionIds.splice(0) } } });
});
afterAll(async () => { await db.$disconnect(); });

describe("阶段真实 API 鉴权与门禁", () => {
  it("本人可读取及启动，同 trigger 恢复；他人 404，未登录 401，响应不含答案及评分标准", async () => {
    const user = await account(true);
    const other = await account(true);
    for (let i = 0; i < 3; i++) {
      const q = await question();
      await withUserTransaction(db, user.id, async context => {
        const metadata = await nextScoringMetadataInTransaction(context, [dimension]);
        await context.tx.trainingSession.create({ data: {
          userId: user.id, questionId: q.id, date: new Date(), state: "scored", scoredAt: new Date(), firstAnswer: "不能泄露的答案", ...metadata,
          scores: { create: { dimension, rawScore: 80, effectiveScore: 80, coefficient: 1, hintCount: 0 } },
        } });
      });
    }
    await question();
    expect((await GET(request(null))).status).toBe(401);
    const view = await GET(request(user));
    expect(view.status).toBe(200);
    const payload = await view.json();
    const item = payload.data.dimensions.find((row: { dimension: string }) => row.dimension === dimension);
    expect(item.triggerId).toBeTruthy();
    expect(JSON.stringify(payload)).not.toMatch(/不能泄露|不能从阶段返回/);
    expect((await POST(request(null, { triggerId: item.triggerId }))).status).toBe(401);
    expect((await POST(request(other, { triggerId: item.triggerId }))).status).toBe(404);
    const started = await POST(request(user, { triggerId: item.triggerId }));
    expect(started.status).toBe(200);
    const result = (await started.json()).data;
    expect(result.state).toBe("ready");
    expect((await (await POST(request(user, { triggerId: item.triggerId }))).json()).data.sessionId).toBe(result.sessionId);
  });

  it("无完成基线时只读且不能启动，不生成阶段进度", async () => {
    const user = await account(false);
    const view = await GET(request(user));
    expect(view.status).toBe(200);
    expect((await view.json()).data.baselineCompleted).toBe(false);
    expect((await POST(request(user, { triggerId: randomUUID() }))).status).toBe(409);
    expect(await db.stageProgress.count({ where: { userId: user.id } })).toBe(0);
  });
});
