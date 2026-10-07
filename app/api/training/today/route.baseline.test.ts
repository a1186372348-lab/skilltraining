import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";

import { DEV_USER_HEADER } from "@/server/lib/dev-identity";
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

function buildRequest(email: string): Request {
  return new Request("http://localhost/api/training/today", {
    method: "GET",
    headers: { [DEV_USER_HEADER]: email },
  });
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

/** dev-identity 走真实用户 upsert（不触门禁），用全新邮箱避免与基线会话数据串扰 */
async function newEmail(): Promise<string> {
  return `t17a-today-gate-${randomUUID()}@example.com`;
}

async function trackUser(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) createdUserIds.push(user.id);
}

describe("GET /api/training/today：基线门禁分支（T17a / D19 / BR-9）", () => {
  it("基线未完成 → 返回基线会话（kind=baseline + 进度），不调用每日一题服务", async () => {
    const question = makeQuestion("bq-1", "基线题一");
    mockedGetBaselineStatus.mockResolvedValue({
      required: true,
      total: 2,
      doneCount: 0,
      nextQuestion: question,
      completedAt: null,
    } as never);
    mockedGetOrCreateBaselineSession.mockResolvedValue({
      session: makeSession(question.id),
      question,
      status: { required: true, total: 2, doneCount: 0 },
    } as never);

    const email = await newEmail();
    const res = await GET(buildRequest(email));
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.kind).toBe("baseline");
    expect(json.data.baselineProgress).toEqual({ done: 0, total: 2 });
    expect(json.data.caseTitle).toBe("基线题一");
    expect(mockedGetOrCreateTodaySession).not.toHaveBeenCalled();
    await trackUser(email);
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
    const res = await GET(buildRequest(email));
    const json = await res.json();

    expect(json.data.kind).toBe("daily");
    expect(json.data.baselineProgress).toBeNull();
    expect(json.data.caseTitle).toBe("日常题");
    expect(mockedGetOrCreateBaselineSession).not.toHaveBeenCalled();
    await trackUser(email);
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
    const res = await GET(buildRequest(email));
    const json = await res.json();

    expect(json.data.kind).toBe("daily");
    expect(json.data.caseTitle).toBe("日常题");
    await trackUser(email);
  });
});
