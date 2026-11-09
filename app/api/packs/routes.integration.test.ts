import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";
import { POST as terminateSession } from "@/app/api/training/[id]/abandon/route";
import { GET as getActive } from "./active/route";
import { GET as getPack } from "./[id]/route";
import { POST as abandonPack } from "./[id]/abandon/route";
import { POST as startItem } from "./[id]/items/[index]/start/route";
import { POST as createPack } from "./route";

const db = new PrismaClient();
const userIds: string[] = [];
const questionIds: string[] = [];

async function user(completed: boolean) {
  const row = await db.user.create({ data: {
    email: `t30-api-${randomUUID()}@example.com`, profile: { create: {
      position: "测试", yearsExperience: "1", industry: "测试", familiarProducts: [], interestAreas: [],
      selfAssessment: {}, baselineCompletedAt: completed ? new Date() : null,
    } },
  } });
  userIds.push(row.id);
  return row;
}

function request(account: { id: string; email: string } | null, body?: unknown) {
  return new Request("http://localhost/api/packs", {
    method: "POST", headers: account ? { cookie: sessionCookieHeader(account) } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function abandonRequest(account: { id: string; email: string } | null, packId: string, body?: unknown) {
  return new Request(`http://localhost/api/packs/${packId}/abandon`, {
    method: "POST", headers: account ? { cookie: sessionCookieHeader(account) } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  const [row] = await db.$queryRaw<{ database: string; schema: string }[]>`SELECT current_database() AS database, current_schema() AS schema`;
  if (row.database !== "skilltraining_test" || !/^v2_core_20261103_[a-f0-9]{12}$/.test(row.schema)) throw new Error("测试库隔离不匹配");
});
afterEach(async () => {
  await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  await db.question.deleteMany({ where: { id: { in: questionIds.splice(0) } } });
});
afterAll(async () => { await db.$disconnect(); });

describe("训练包 API 身份、门禁与终止确认", () => {
  it("真实放弃路由校验登录、本人和确认，成功后保留先前评分", async () => {
    const owner = await user(true);
    const stranger = await user(true);
    for (const difficulty of [1, 2, 2, 3, 4]) {
      const question = await db.question.create({ data: {
        caseTitle: `放弃路由测试 ${randomUUID()}`, caseBackground: {}, mainQuestion: "问题", abilityTags: ["问题定义"],
        difficulty, rubric: { private: "secret" }, hintTree: [], materials: {}, status: "published", kind: "daily",
      } });
      questionIds.push(question.id);
    }
    const created = await createPack(request(owner, { dimension: "问题定义" }));
    expect(created.status).toBe(200);
    const packId = (await created.json()).data.pack.id;
    const context = { params: Promise.resolve({ id: packId }) };
    const start = (index: string) => startItem(request(owner), { params: Promise.resolve({ id: packId, index }) });
    const first = await start("0");
    expect(first.status).toBe(200);
    const firstId = (await first.json()).data.sessionId;
    const at = new Date();
    await db.trainingSession.update({ where: { id: firstId }, data: {
      state: "scored", firstAnswer: "首答", firstSubmittedAt: at, finalAnswer: "终答", finalSubmittedAt: at, scoredAt: at,
      scores: { create: { dimension: "问题定义", rawScore: 80, hintCount: 0, coefficient: 1, effectiveScore: 80 } },
    } });
    const second = await start("1");
    expect(second.status).toBe(200);
    const secondId = (await second.json()).data.sessionId;

    expect((await abandonPack(abandonRequest(null, packId, { confirmed: true }), context)).status).toBe(401);
    expect((await abandonPack(abandonRequest(stranger, packId, { confirmed: true }), context)).status).toBe(404);
    for (const body of [undefined, { confirmed: false }]) {
      const refused = await abandonPack(abandonRequest(owner, packId, body), context);
      expect(refused.status).toBe(409);
      expect((await refused.json()).error.code).toBe("CONFIRMATION_REQUIRED");
    }
    expect((await db.trainingPack.findUniqueOrThrow({ where: { id: packId } })).status).toBe("active");
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: secondId } })).state).toBe("reading");

    const abandoned = await abandonPack(abandonRequest(owner, packId, { confirmed: true }), context);
    expect(abandoned.status).toBe(200);
    const result = await abandoned.json();
    expect(result.data.pack).toMatchObject({ id: packId, status: "abandoned" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: secondId } })).state).toBe("abandoned");
    expect(await db.score.count({ where: { sessionId: firstId, effectiveScore: 80 } })).toBe(1);
    expect((await abandonPack(abandonRequest(owner, packId, { confirmed: true }), context)).status).toBe(200);
  });

  it("本人可创建和开题；他人不可读取；未基线及未确认都不写状态", async () => {
    const owner = await user(true);
    const stranger = await user(true);
    const incomplete = await user(false);
    for (const difficulty of [1, 2, 2, 3, 4]) {
      const question = await db.question.create({ data: {
        caseTitle: `接口测试 ${randomUUID()}`, caseBackground: {}, mainQuestion: "问题", abilityTags: ["问题定义"],
        difficulty, rubric: { private: "secret" }, hintTree: [], materials: {}, status: "published", kind: "daily",
      } });
      questionIds.push(question.id);
    }
    expect((await createPack(request(null, { dimension: "问题定义" }))).status).toBe(401);
    const blocked = await createPack(request(incomplete, { dimension: "问题定义" }));
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("BASELINE_REQUIRED");
    expect(await db.trainingPack.count({ where: { userId: incomplete.id } })).toBe(0);
    const created = await createPack(request(owner, { dimension: "问题定义" }));
    expect(created.status).toBe(200);
    const pack = (await created.json()).data.pack;
    expect(typeof pack.createdAt).toBe("string");
    expect(JSON.stringify(pack)).not.toContain("secret");
    const params = { params: Promise.resolve({ id: pack.id }) };
    expect((await getPack(request(stranger), params)).status).toBe(404);
    expect((await getActive(request(owner))).status).toBe(200);
    const start = (index: string) => startItem(request(owner), { params: Promise.resolve({ id: pack.id, index }) });
    expect((await start("1")).status).toBe(409);
    const opened = await start("0");
    expect(opened.status).toBe(200);
    const sessionId = (await opened.json()).data.sessionId;
    const sessionContext = { params: Promise.resolve({ id: sessionId }) };
    const unconfirmed = await terminateSession(request(owner), sessionContext);
    expect(unconfirmed.status).toBe(409);
    expect((await unconfirmed.json()).error.code).toBe("CONFIRMATION_REQUIRED");
    expect((await db.trainingPack.findUniqueOrThrow({ where: { id: pack.id } })).status).toBe("active");
    expect((await terminateSession(request(owner, { confirmAbandonPack: true }), sessionContext)).status).toBe(200);
    expect((await db.trainingPack.findUniqueOrThrow({ where: { id: pack.id } })).status).toBe("abandoned");
    expect((await db.trainingSession.findUniqueOrThrow({ where: { id: sessionId } })).state).toBe("abandoned");
  });
});
