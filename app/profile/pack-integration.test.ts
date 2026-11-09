import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, expect, it, vi } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";
import { GET as profileRoute } from "@/app/api/profile/ability/route";
import { GET as hubRoute } from "@/app/api/training/hub/route";
import { POST as createRoute } from "@/app/api/packs/route";
import { GET as packRoute } from "@/app/api/packs/[id]/route";
import { POST as startRoute } from "@/app/api/packs/[id]/items/[index]/start/route";
import { GET as sessionRoute } from "@/app/api/training/[id]/route";
import { POST as abandonSessionRoute } from "@/app/api/training/[id]/abandon/route";
import { GET as historyRoute } from "@/app/api/history/[id]/route";
import { fetchHistoryDetail } from "@/app/training/history/api";
import { fetchTrainingHub } from "@/app/training/api";
import { abandonPackSession, fetchPack, startPackItem } from "@/app/training/pack/api";
import { fetchSessionById } from "@/app/training/session/api";
import { scoreSession } from "@/server/modules/scoring/service";
import { createTrainingPack, fetchAbilityProfile } from "./api";

const db = new PrismaClient();
const users: string[] = [];
const questions: string[] = [];

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.question.deleteMany({ where: { id: { in: questions } } });
  await db.$disconnect();
});

/** 请求只分派到本进程内真实路由，不访问任何外部网络。 */
function connectRoutes(cookie: string) {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "http://localhost");
    const headers = new Headers(init?.headers);
    headers.set("cookie", cookie);
    const request = new Request(url, { ...init, headers });
    if (url.pathname === "/api/profile/ability") return profileRoute(request);
    if (url.pathname === "/api/training/hub") return hubRoute(request);
    if (url.pathname === "/api/packs") return createRoute(request);
    const item = /^\/api\/packs\/([^/]+)\/items\/(\d+)\/start$/.exec(url.pathname);
    if (item) return startRoute(request, { params: Promise.resolve({ id: item[1], index: item[2] }) });
    const pack = /^\/api\/packs\/([^/]+)$/.exec(url.pathname);
    if (pack) return packRoute(request, { params: Promise.resolve({ id: pack[1] }) });
    const abandon = /^\/api\/training\/([^/]+)\/abandon$/.exec(url.pathname);
    if (abandon) return abandonSessionRoute(request, { params: Promise.resolve({ id: abandon[1] }) });
    const session = /^\/api\/training\/([^/]+)$/.exec(url.pathname);
    if (session) return sessionRoute(request, { params: Promise.resolve({ id: session[1] }) });
    const history = /^\/api\/history\/([^/]+)$/.exec(url.pathname);
    if (history) return historyRoute(request, { params: Promise.resolve({ id: history[1] }) });
    throw new Error("测试禁止访问未登记的地址");
  });
}

it("真实前后端契约贯通画像发包、逐题评分解锁、诊断及确认放弃", async () => {
  const user = await db.user.create({ data: { email: `pack-ui-${randomUUID()}@example.com`, profile: { create: {
    position: "测试", yearsExperience: "1", industry: "测试", familiarProducts: [], interestAreas: [],
    selfAssessment: {}, baselineCompletedAt: new Date("2026-01-01T00:00:00Z"),
  } } } });
  users.push(user.id);
  for (let i = 0; i < 10; i++) {
    const id = randomUUID(); questions.push(id);
    await db.question.create({ data: {
      id, kind: "daily", status: "published", caseTitle: `合成案例 ${i}`, caseBackground: {},
      mainQuestion: "如何判断？", abilityTags: ["问题定义"], difficulty: [1, 2, 3, 3, 4][i % 5],
      rubric: { dimensions: { 问题定义: ["提供判断依据"] } }, hintTree: [], materials: {},
    } });
  }
  connectRoutes(sessionCookieHeader(user));
  const before = await fetchAbilityProfile();
  expect(before.dimensions.find((d) => d.dimension === "问题定义")?.packCta?.status).toBe("available");
  const id = await createTrainingPack("问题定义");
  let detail = await fetchPack(id);
  expect(typeof detail.createdAt).toBe("string");
  expect(detail.items.map((item) => item.targetTier)).toEqual(["basic", "basic", "advanced", "advanced", "challenge"]);
  expect(detail.items[0].state).toBe("available");

  for (let index = 0; index < 5; index++) {
    const opened = await startPackItem(id, index);
    expect(opened.state).toBe("in_progress");
    const workbench = await fetchSessionById(opened.sessionId);
    expect(workbench).toMatchObject({ sourceType: "pack", sourceId: id, finalSubmittedAt: null });
    await db.trainingSession.update({ where: { id: opened.sessionId }, data: {
      state: "followup", firstAnswer: "合成首答", finalAnswer: "合成终答", finalSubmittedAt: new Date(),
    } });
    await scoreSession(db, opened.sessionId, user.id, { scoreWithRubric: async () => ({
      dimensions: [{ dimension: "问题定义", rawScore: 50 + index * 10, diagnosis: "合成诊断" }],
      topIssue: "补充判断依据", nextFocus: "设计验证方法", confidence: 90,
    }) });
    detail = await fetchPack(id);
    expect(detail.items[index].state).toBe("scored");
    if (index < 4) expect(detail.items[index + 1].state).toBe("available");
  }
  expect(detail.status).toBe("completed");
  expect(detail.diagnosis.trajectory.map((point) => point.effectiveScore)).toEqual([50, 60, 70, 80, 90]);
  expect(detail.diagnosis.advice).toContain("验证");
  const hub = await fetchTrainingHub();
  const completedHistory = hub.history.find((item) => item.sourceType === "pack" && item.sourceId === id);
  expect(completedHistory?.sourceId).toBe(id);
  const reopened = await fetchPack(completedHistory!.sourceId!);
  expect(reopened.status).toBe("completed");
  expect(reopened.diagnosis.trajectory.map((point) => point.effectiveScore)).toEqual([50, 60, 70, 80, 90]);
  const history = await fetchHistoryDetail(detail.items[0].sessionId!);
  expect(history.finalAnswer).toBe("合成终答");
  expect(history.feedback?.topIssueText).toBe("补充判断依据");

  const nextId = await createTrainingPack("问题定义");
  const next = await startPackItem(nextId, 0);
  await abandonPackSession(next.sessionId);
  expect((await fetchPack(nextId)).status).toBe("abandoned");
  expect(await db.score.count({ where: { session: { userId: user.id } } })).toBe(5);
}, 30000);
