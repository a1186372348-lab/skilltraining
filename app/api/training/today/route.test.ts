import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DEV_USER_HEADER } from "@/server/lib/dev-identity";

import { GET } from "./route";

// GET /api/training/today 集成测试：真实数据库；本端点不触发 AI 调用。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

const SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000a1";

// 全量规范种子数据：各测试文件共用同一题目 id，upsert 保证跨文件并发播种结果一致
const SEED_QUESTION_DATA = {
  id: SEED_QUESTION_ID,
  caseTitle: "T05 集成测试种子题",
  caseBackground: { product: "测试产品", audience: "测试用户", scenario: "测试场景" },
  mainQuestion: "测试主问题？",
  abilityTags: ["用户理解", "产品价值判断", "产品取舍"],
  difficulty: 2,
  rubric: {
    dimensions: {
      用户理解: ["绝密要点1", "绝密要点2", "绝密要点3"],
      产品价值判断: ["绝密要点1", "绝密要点2", "绝密要点3"],
      产品取舍: ["绝密要点1", "绝密要点2", "绝密要点3"],
    },
    forbidden_leaks: ["绝密结论"],
  },
  hintTree: [1, 2, 3, 4, 5].map((level) => ({
    level,
    stage: `阶段${level}`,
    question: `第${level}层提示`,
  })),
  materials: {
    core: [
      { title: "核心1", source: "测试来源", url: "https://example.com/core-1", summary: "核心摘要1" },
      { title: "核心2", source: "测试来源", url: "https://example.com/core-2", summary: "核心摘要2" },
    ],
    extended: [
      { title: "扩展1", source: "测试来源", url: "https://example.com/ext-1", summary: "扩展摘要1" },
      { title: "扩展2", source: "测试来源", url: "https://example.com/ext-2", summary: "扩展摘要2" },
      { title: "扩展3", source: "测试来源", url: "https://example.com/ext-3", summary: "扩展摘要3" },
    ],
  },
  status: "published" as const,
};

async function ensureSeedQuestion(): Promise<void> {
  const { id, ...data } = SEED_QUESTION_DATA;
  try {
    // 共享开发库已导入真实上架题：先下架本种子外的全部上架题，选题结果才确定命中本种子
    await prisma.question.updateMany({
      where: { status: "published", id: { not: id } },
      data: { status: "archived" },
    });
    await prisma.question.upsert({ where: { id }, create: SEED_QUESTION_DATA, update: data });
  } catch {
    // 并发播种冲突：忽略，题目已存在
  }
}

function buildRequest(email?: string): Request {
  const headers: Record<string, string> = {};
  if (email) headers[DEV_USER_HEADER] = email;
  return new Request("http://localhost/api/training/today", { method: "GET", headers });
}

async function newEmail(): Promise<string> {
  return `t05-today-${randomUUID()}@example.com`;
}

beforeAll(ensureSeedQuestion);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("GET /api/training/today（US-003 / FR-10）", () => {
  it("首次进入创建会话并返回案例/训练重点/主问题/资料；重复进入复用同一会话", async () => {
    const email = await newEmail();
    const first = await (await GET(buildRequest(email))).json();
    const second = await (await GET(buildRequest(email))).json();

    expect(first.success).toBe(true);
    expect(first.data.sessionId).toBe(second.data.sessionId);
    expect(first.data.state).toBe("reading");
    expect(first.data.caseTitle).toBe("T05 集成测试种子题");
    expect(first.data.mainQuestion).toBe("测试主问题？");
    expect(first.data.abilityTags).toEqual(["用户理解", "产品价值判断", "产品取舍"]);
    expect(first.data.materials.core).toHaveLength(2);
    expect(first.data.materials.extended).toHaveLength(3);
    expect(first.data.coefficient).toBe(1.0);
    expect(first.data.canRequestHint).toBe(true);

    const user = await prisma.user.findUnique({ where: { email } });
    if (user) createdUserIds.push(user.id);
  });

  it("响应绝不含 Rubric 与未释放提示层（FR-10）", async () => {
    const email = await newEmail();
    const res = await GET(buildRequest(email));
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain("绝密要点");
    expect(raw).not.toContain("绝密结论");
    expect(raw).not.toContain("rubric");
    expect(raw).not.toContain("第2层提示"); // 未请求提示时一层都不下发
    expect(raw).not.toContain("第1层提示");

    const user = await prisma.user.findUnique({ where: { email } });
    if (user) createdUserIds.push(user.id);
  });

  it("生产环境（T03 未接入）无会话：401", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(buildRequest(await newEmail()));
    expect(res.status).toBe(401);
    vi.unstubAllEnvs();
  });
});
