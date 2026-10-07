import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DEV_USER_HEADER } from "@/server/lib/dev-identity";

import { POST } from "./route";

// POST /api/training/extra 集成测试（T21 / D3）：真实数据库。
// 覆盖：鉴权 401、统一限流 429、成功返回 sessionId、进行中幂等复用返回同 id。

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
  return new Request("http://localhost/api/training/extra", { method: "POST", headers });
}

async function newUser(): Promise<{ email: string; userId: string }> {
  const email = `t21-extra-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email } });
  createdUserIds.push(user.id);
  return { email, userId: user.id };
}

beforeAll(ensureSeedQuestion);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("POST /api/training/extra（T21 / D3：加练会话入口）", () => {
  it("成功：创建加练会话并返回 sessionId（isExtra=true、state=reading）", async () => {
    const { email, userId } = await newUser();

    const res = await POST(buildRequest(email));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(typeof json.data.sessionId).toBe("string");

    const session = await prisma.trainingSession.findUniqueOrThrow({
      where: { id: json.data.sessionId },
    });
    expect(session.userId).toBe(userId);
    expect(session.isExtra).toBe(true);
    expect(session.state).toBe("reading");
    expect(session.questionId).toBe(SEED_QUESTION_ID);
  });

  it("幂等：进行中会话存在时重复调用返回同一 sessionId（防连点）", async () => {
    const { email, userId } = await newUser();

    const first = await (await POST(buildRequest(email))).json();
    const second = await (await POST(buildRequest(email))).json();
    expect(second.data.sessionId).toBe(first.data.sessionId);
    expect(await prisma.trainingSession.count({ where: { userId } })).toBe(1);
  });

  it("生产环境（T03 未接入）无会话：401", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await POST(buildRequest());
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
    vi.unstubAllEnvs();
  });

  it("限流：与既有训练端点同一 AI 端点限流，超额返回 429（Prd.md 3.5）", async () => {
    const { email } = await newUser();
    // 进行中会话幂等复用，30 次额度内全部放行
    for (let i = 0; i < 30; i += 1) {
      const res = await POST(buildRequest(email));
      expect(res.status).toBe(200);
    }
    const res = await POST(buildRequest(email));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(json.error.retryAfterSeconds).toBeGreaterThan(0);
  });
});
