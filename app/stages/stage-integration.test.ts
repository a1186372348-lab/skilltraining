import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "@/app/api/_test/session";
import { GET as overviewRoute } from "@/app/api/stages/overview/route";
import { POST as startRoute } from "@/app/api/stages/retest/start/route";
import { GET as todayRoute } from "@/app/api/training/today/route";
import { GET as sessionRoute } from "@/app/api/training/[id]/route";
import { POST as abandonRoute } from "@/app/api/training/[id]/abandon/route";
import { GET as historyRoute } from "@/app/api/history/[id]/route";
import { fetchHistoryDetail } from "@/app/training/history/api";
import { abandonSession, fetchSessionById, fetchTodaySession } from "@/app/training/session/api";
import { scoreSession } from "@/server/modules/scoring/service";
import { fetchStageOverview, startRetest } from "./api";

const db = new PrismaClient();
const users: string[] = [];
const questions: string[] = [];
const dimension = "问题定义";
let verified = false;

beforeAll(async () => {
  const [row] = await db.$queryRaw<{ database: string; schema: string }[]>`SELECT current_database() AS database, current_schema() AS schema`;
  if (row.database !== "skilltraining_test" || !/^v2_core_20261103_[a-f0-9]{12}$/.test(row.schema)) throw new Error("隔离测试库身份不匹配");
  verified = true;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  if (verified) {
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.question.deleteMany({ where: { id: { in: questions } } });
  }
  await db.$disconnect();
});

/** 客户端请求只分派至本进程的真实路由，不访问外网。 */
function connectRoutes(cookie: string) {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "http://localhost");
    const headers = new Headers(init?.headers);
    headers.set("cookie", cookie);
    const request = new Request(url, { ...init, headers });
    if (url.pathname === "/api/stages/overview") return overviewRoute(request);
    if (url.pathname === "/api/stages/retest/start") return startRoute(request);
    if (url.pathname === "/api/training/today") return todayRoute(request);
    const abandon = /^\/api\/training\/([^/]+)\/abandon$/.exec(url.pathname);
    if (abandon) return abandonRoute(request, { params: Promise.resolve({ id: abandon[1] }) });
    const session = /^\/api\/training\/([^/]+)$/.exec(url.pathname);
    if (session) return sessionRoute(request, { params: Promise.resolve({ id: session[1] }) });
    const history = /^\/api\/history\/([^/]+)$/.exec(url.pathname);
    if (history) return historyRoute(request, { params: Promise.resolve({ id: history[1] }) });
    throw new Error("测试禁止访问未登记的地址");
  });
}

async function grade(userId: string, sessionId: string, value: number) {
  return scoreSession(db, sessionId, userId, { scoreWithRubric: async () => ({
    dimensions: [{ dimension, rawScore: value, diagnosis: "合成诊断" }],
    topIssue: "补充判断依据", nextFocus: "设计验证方法", confidence: 90,
  }) });
}

it("真实客户端贯通触发复测、独立日常、终止换题及 60 分通过", async () => {
  const user = await db.user.create({ data: { email: `stage-ui-${randomUUID()}@example.com`, profile: { create: {
    position: "测试", yearsExperience: "1", industry: "测试", familiarProducts: [], interestAreas: [], selfAssessment: {}, baselineCompletedAt: new Date("2026-01-01T00:00:00Z"),
  } } } });
  users.push(user.id);
  for (let index = 0; index < 9; index++) {
    const id = randomUUID(); questions.push(id);
    await db.question.create({ data: { id, kind: "daily", status: "published", caseTitle: `合成案例 ${index}`, caseBackground: {}, mainQuestion: "合成问题", abilityTags: [dimension], difficulty: 2, rubric: { dimensions: { [dimension]: ["合成要点"] } }, hintTree: [], materials: {} } });
  }
  for (let index = 0; index < 3; index++) {
    const session = await db.trainingSession.create({ data: { userId: user.id, questionId: questions[index], date: new Date("2026-01-01T00:00:00Z"), sourceType: "extra", isExtra: true, state: "followup", firstAnswer: "合成首答", finalAnswer: "合成终答", finalSubmittedAt: new Date() } });
    await grade(user.id, session.id, 80);
  }
  connectRoutes(sessionCookieHeader(user));
  const triggered = await fetchStageOverview();
  expect(triggered.stage).toBe("exploration");
  const dimensionView = triggered.dimensions.find((item) => item.dimension === dimension);
  expect(dimensionView?.status).toBe("pending");
  expect(dimensionView?.triggerId).toBeTruthy();
  const triggerId = dimensionView!.triggerId!;
  const started = await startRetest(triggerId);
  expect(started.state).toBe("ready");
  if (started.state !== "ready") throw new Error("复测未开始");
  expect(await fetchSessionById(started.sessionId)).toMatchObject({ sourceType: "retest", sourceId: triggerId });
  expect((await fetchStageOverview()).dimensions.find((item) => item.dimension === dimension)?.activeSessionStatus).toBe("in_progress");
  const daily = await fetchTodaySession("daily");
  expect(daily?.sessionId).toBeTruthy();
  expect(daily?.sessionId).not.toBe(started.sessionId);
  expect(daily?.sourceType).not.toBe("retest");

  await abandonSession(started.sessionId);
  const restarted = await startRetest(triggerId);
  expect(restarted.state).toBe("ready");
  if (restarted.state !== "ready") throw new Error("复测未恢复");
  expect(restarted.sessionId).not.toBe(started.sessionId);
  await db.trainingSession.update({ where: { id: restarted.sessionId }, data: { state: "followup", firstAnswer: "合成首答", finalAnswer: "合成终答", finalSubmittedAt: new Date() } });
  expect((await fetchStageOverview()).dimensions.find((item) => item.dimension === dimension)?.activeSessionStatus).toBe("awaiting_score");
  await grade(user.id, restarted.sessionId, 60);
  const finished = await fetchStageOverview();
  expect(finished.dimensions.find((item) => item.dimension === dimension)?.status).toBe("verified");
  expect(finished.timeline.some((event) => event.type === "retest_pass" && event.resultEffectiveScore === 60)).toBe(true);
  expect(JSON.stringify(finished)).not.toMatch(/合成终答|合成要点|合成问题/);
  expect((await fetchHistoryDetail(restarted.sessionId)).sourceType).toBe("retest");
}, 30000);
