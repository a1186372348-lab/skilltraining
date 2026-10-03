import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DEV_USER_HEADER } from "@/server/lib/dev-identity";

import { GET } from "./route";

// GET /api/history 集成测试（T10 / US-009）：真实数据库。
// 覆盖：分页元数据（页码/每页/总数）、日期倒序、仅当前用户记录、
// 列表项字段（日期/案例名/训练重点/有效分摘要/状态）、参数校验、空态。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

// 独立种子题 id（与 T05 及其他测试文件的种子题隔离，避免并发 upsert 互相覆盖）
const SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000b1";

async function ensureSeedQuestion(): Promise<void> {
  const data = {
    caseTitle: "T10 路由测试种子题",
    caseBackground: {
      product: "测试产品",
      audience: "测试用户",
      scenario: "测试场景",
      related_features: "测试功能",
      current_status: "测试状态",
    },
    mainQuestion: "测试主问题？",
    abilityTags: ["用户理解", "产品价值判断", "产品取舍"],
    difficulty: 2,
    rubric: { dimensions: {}, forbidden_leaks: ["绝密结论"] },
    hintTree: [1, 2, 3, 4, 5].map((level) => ({
      level,
      stage: `阶段${level}`,
      question: `第${level}层提示`,
    })),
    materials: { core: [], extended: [] },
    status: "published" as const,
  };
  try {
    await prisma.question.upsert({
      where: { id: SEED_QUESTION_ID },
      create: { id: SEED_QUESTION_ID, ...data },
      update: data,
    });
  } catch {
    // 并发播种冲突：忽略
  }
}

async function newUser(prefix: string) {
  const user = await prisma.user.create({
    data: { email: `${prefix}-${randomUUID()}@example.com` },
  });
  createdUserIds.push(user.id);
  return user;
}

function callList(email: string, query = "") {
  const request = new Request(`http://localhost/api/history${query}`, {
    headers: { [DEV_USER_HEADER]: email },
  });
  return GET(request);
}

beforeAll(ensureSeedQuestion);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("GET /api/history（列表与分页）", () => {
  it("默认分页：按日期倒序返回，分页元数据含页码/每页/总数，仅当前用户记录", async () => {
    const mine = await newUser("t10-list");
    const stranger = await newUser("t10-list-stranger");
    // 我的 3 条：10-01 / 10-03 / 10-02（写入乱序，响应必须日期倒序）
    for (const day of [1, 3, 2]) {
      const session = await prisma.trainingSession.create({
        data: {
          userId: mine.id,
          questionId: SEED_QUESTION_ID,
          date: new Date(Date.UTC(2026, 9, day)),
          state: "scored",
          firstAnswer: "首答",
          firstSubmittedAt: new Date(),
          finalAnswer: "终答",
          finalSubmittedAt: new Date(),
        },
      });
      await prisma.score.create({
        data: {
          sessionId: session.id,
          dimension: "用户理解",
          rawScore: 85,
          hintCount: 0,
          coefficient: 1,
          effectiveScore: 85,
        },
      });
    }
    // 他人记录不应出现
    await prisma.trainingSession.create({
      data: {
        userId: stranger.id,
        questionId: SEED_QUESTION_ID,
        date: new Date(Date.UTC(2026, 9, 4)),
        state: "scored",
      },
    });

    const res = await callList(mine.email);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.pagination).toEqual({ page: 1, pageSize: 10, total: 3, totalPages: 1 });

    const items = json.data.items;
    expect(items).toHaveLength(3);
    expect(items.map((item: { date: string }) => item.date)).toEqual([
      "2026-10-03",
      "2026-10-02",
      "2026-10-01",
    ]);

    // 列表项五要素：日期 / 案例名 / 训练重点 / 有效分摘要 / 状态
    const first = items[0];
    expect(first.caseTitle).toBe("T10 路由测试种子题");
    expect(first.abilityTags).toEqual(["用户理解", "产品价值判断", "产品取舍"]);
    expect(first.state).toBe("scored");
    expect(first.scores).toEqual([{ dimension: "用户理解", effectiveScore: 85 }]);
    expect(typeof first.sessionId).toBe("string");
    expect(first.isExtra).toBe(false);
  });

  it("显式分页参数：page=2&pageSize=2 返回第 2 页与正确 totalPages", async () => {
    const user = await newUser("t10-list-page2");
    for (let day = 1; day <= 5; day += 1) {
      await prisma.trainingSession.create({
        data: {
          userId: user.id,
          questionId: SEED_QUESTION_ID,
          date: new Date(Date.UTC(2026, 9, day)),
          state: "answering",
        },
      });
    }

    const res = await callList(user.email, "?page=2&pageSize=2");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.pagination).toEqual({ page: 2, pageSize: 2, total: 5, totalPages: 3 });
    expect(json.data.items.map((item: { date: string }) => item.date)).toEqual([
      "2026-10-03",
      "2026-10-02",
    ]);
    // 进行中会话无评分摘要
    expect(json.data.items[0].scores).toEqual([]);
    expect(json.data.items[0].state).toBe("answering");
  });

  it("空态：无记录用户返回空 items 与 total=0，而非报错", async () => {
    const user = await newUser("t10-list-empty");
    const res = await callList(user.email);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.items).toEqual([]);
    expect(json.data.pagination).toEqual({ page: 1, pageSize: 10, total: 0, totalPages: 0 });
  });

  it("非法分页参数：page=0 / pageSize=0 / pageSize=51 / 非数字均 400", async () => {
    const user = await newUser("t10-list-bad-params");
    for (const query of ["?page=0", "?page=-1", "?pageSize=0", "?pageSize=51", "?page=abc", "?pageSize=1.5"]) {
      const res = await callList(user.email, query);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("INVALID_PAGINATION");
    }
  });

  it("未登录（生产环境无身份解析）：401 UNAUTHORIZED", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const res = await callList("t10-list-anon@example.com");
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("UNAUTHORIZED");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("FR-10：列表响应不泄露 rubric / hintTree / 提示内容", async () => {
    const user = await newUser("t10-list-fr10");
    await prisma.trainingSession.create({
      data: {
        userId: user.id,
        questionId: SEED_QUESTION_ID,
        date: new Date(Date.UTC(2026, 9, 1)),
        state: "scored",
      },
    });
    const res = await callList(user.email);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("rubric");
    expect(body).not.toContain("hintTree");
    expect(body).not.toContain("绝密");
    expect(body).not.toContain("层提示");
  });
});
