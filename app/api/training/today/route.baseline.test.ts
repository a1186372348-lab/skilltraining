import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";

import { sessionCookieHeader } from "@/app/api/_test/session";
import { BASELINE_ERROR_CODES, BaselineError } from "@/server/modules/baseline/errors";
import {
  getBaselineStatus,
  getOrCreateBaselineSession,
} from "@/server/modules/baseline/service";
import { getOrCreateTodaySession } from "@/server/modules/training/service";

import { GET } from "./route";

// GET /api/training/today 基线门禁分支测试（T17a / D19）：mock 服务层。
//
// 为什么 mock：基线门禁依赖 questions 表全局状态，多文件并行共享测试库时
// 上架基线题会干扰其他文件（双向竞争）；门禁的分支逻辑（是否走基线会话、
// 视图 kind/进度标注、竞态回退日常）用 mock 即可确定性验证。
// 日常题真实库行为见同目录 route.test.ts；服务层逻辑见 server/modules/baseline。

vi.mock("@/server/modules/baseline/service", () => ({
  getBaselineStatus: vi.fn(),
  getOrCreateBaselineSession: vi.fn(),
}));

vi.mock("@/server/modules/training/service", () => ({
  getOrCreateTodaySession: vi.fn(),
  // T21：路由先查当天最近非基线会话；本文件用例固定返回 null（走每日一题分支）
  getLatestDailySession: vi.fn(async () => null),
}));

const mockedGetBaselineStatus = vi.mocked(getBaselineStatus);
const mockedGetOrCreateBaselineSession = vi.mocked(getOrCreateBaselineSession);
const mockedGetOrCreateTodaySession = vi.mocked(getOrCreateTodaySession);

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

function makeQuestion(id: string, caseTitle: string) {
  return {
    id,
    caseTitle,
    caseBackground: { product: "测试产品" },
    mainQuestion: "主问题？",
    abilityTags: ["用户理解"],
    difficulty: 2,
    hintTree: [1, 2, 3, 4, 5].map((level) => ({
      level,
      stage: `阶段${level}`,
      question: `第${level}层提示`,
    })),
    materials: { core: [], extended: [] },
    status: "published",
  };
}

function makeSession(questionId: string) {
  return {
    id: `session-${questionId}`,
    state: "reading",
    date: new Date("2026-10-04T00:00:00Z"),
    hintCount: 0,
    firstAnswer: null,
    finalAnswer: null,
    firstSubmittedAt: null,
    followups: null,
  };
}

async function buildRequest(email: string): Promise<Request> {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email },
    update: {},
  });
  createdUserIds.push(user.id);
  return new Request("http://localhost/api/training/today", {
    method: "GET",
    headers: { cookie: sessionCookieHeader(user) },
  });
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

/** 真实会话 cookie 需用户已存在（不触门禁），用全新邮箱避免与基线会话数据串扰 */
async function newEmail(): Promise<string> {
  return `t17a-today-gate-${randomUUID()}@example.com`;
}

describe("GET /api/training/today：基线门禁分支（T17a / D19 / BR-9）", () => {
  it("基线未完成 → 返回基线会话（kind=baseline + 进度按已作答口径），不调用每日一题服务", async () => {
    const question = makeQuestion("bq-1", "基线题一");
    mockedGetBaselineStatus.mockResolvedValue({
      required: true,
      total: 2,
      answeredCount: 1,
      doneCount: 0,
      nextQuestion: question,
      completedAt: null,
      pendingScoringSessionIds: [],
    } as never);
    mockedGetOrCreateBaselineSession.mockResolvedValue({
      session: makeSession(question.id),
      question,
      status: { required: true, total: 2, answeredCount: 1, doneCount: 0 },
    } as never);

    const email = await newEmail();
    const res = await GET(await buildRequest(email));
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.kind).toBe("baseline");
    // T36 / D38：进度口径统一为已作答（answeredCount），用户不再等评分
    expect(json.data.baselineProgress).toEqual({ done: 1, total: 2 });
    expect(json.data.caseTitle).toBe("基线题一");
    expect(mockedGetOrCreateTodaySession).not.toHaveBeenCalled();
  });

  it("全部已作答未全部评完（required 且 nextQuestion=null）→ 409 BASELINE_SCORING_PENDING，不落日常分支（T36 / D38）", async () => {
    mockedGetBaselineStatus.mockResolvedValue({
      required: true,
      total: 8,
      answeredCount: 8,
      doneCount: 5,
      nextQuestion: null,
      completedAt: null,
      pendingScoringSessionIds: ["s-1", "s-2", "s-3"],
    } as never);

    const email = await newEmail();
    const res = await GET(await buildRequest(email));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(BASELINE_ERROR_CODES.BASELINE_SCORING_PENDING);
    // 画像未齐：不得创建/返回基线会话，也不得落入日常题
    expect(mockedGetOrCreateBaselineSession).not.toHaveBeenCalled();
    expect(mockedGetOrCreateTodaySession).not.toHaveBeenCalled();
  });

  it("基线完成/无基线题 → 走每日一题（kind=daily，progress 为 null）", async () => {
    mockedGetBaselineStatus.mockResolvedValue({
      required: false,
      total: 2,
      doneCount: 2,
      nextQuestion: null,
      completedAt: new Date(),
    } as never);
    const question = makeQuestion("dq-1", "日常题");
    mockedGetOrCreateTodaySession.mockResolvedValue({
      session: makeSession(question.id),
      question,
    } as never);

    const email = await newEmail();
    const res = await GET(await buildRequest(email));
    const json = await res.json();

    expect(json.data.kind).toBe("daily");
    expect(json.data.baselineProgress).toBeNull();
    expect(json.data.caseTitle).toBe("日常题");
    expect(mockedGetOrCreateBaselineSession).not.toHaveBeenCalled();
  });

  it("竞态：状态检查后基线恰好完成（BaselineError）→ 回退每日一题", async () => {
    mockedGetBaselineStatus.mockResolvedValue({
      required: true,
      total: 2,
      doneCount: 1,
      nextQuestion: makeQuestion("bq-2", "基线题二"),
      completedAt: null,
    } as never);
    mockedGetOrCreateBaselineSession.mockRejectedValue(
      new BaselineError(BASELINE_ERROR_CODES.BASELINE_NOT_REQUIRED, 409, "已完成"),
    );
    const question = makeQuestion("dq-1", "日常题");
    mockedGetOrCreateTodaySession.mockResolvedValue({
      session: makeSession(question.id),
      question,
    } as never);

    const email = await newEmail();
    const res = await GET(await buildRequest(email));
    const json = await res.json();

    expect(json.data.kind).toBe("daily");
    expect(json.data.caseTitle).toBe("日常题");
  });
});
