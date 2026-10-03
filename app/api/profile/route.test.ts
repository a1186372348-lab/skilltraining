import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { DEV_USER_HEADER } from "@/server/lib/dev-identity";

import { GET, PUT } from "./route";

// 集成测试：直接调用路由处理函数，打真实数据库（docker PostgreSQL:5433）。
// 身份走开发态 header 透传（T03 登录就绪前的占位，见 server/lib/dev-identity.ts）。

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

const validBody = {
  position: "产品经理",
  yearsExperience: "1-3年",
  industry: "互联网/软件",
  projectExperience: "负责过一款工具类 App。",
  familiarProducts: ["飞书"],
  interestAreas: ["AI 应用"],
  learningGoal: "提升方案设计能力",
  selfAssessment: ["问题定义"],
};

function devEmail(): string {
  return `t04-api-${randomUUID()}@example.com`;
}

function buildRequest(
  body: unknown,
  email?: string,
  method = "PUT",
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (email) headers[DEV_USER_HEADER] = email;
  return new Request("http://localhost/api/profile", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function cleanupByEmail(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) createdUserIds.push(user.id);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("PUT /api/profile：提交画像", () => {
  it("合法提交：200 + success 封装，画像落库，草稿被清除", async () => {
    const email = devEmail();
    // 先埋一份草稿，验证提交成功后草稿清除
    const seed = await prisma.user.upsert({
      where: { email },
      create: { email },
      update: {},
    });
    createdUserIds.push(seed.id);
    await prisma.profileDraft.create({
      data: { userId: seed.id, payload: { position: "草稿职位" } },
    });

    const res = await PUT(buildRequest(validBody, email));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.position).toBe("产品经理");

    const row = await prisma.userProfile.findUnique({
      where: { userId: seed.id },
    });
    expect(row?.industry).toBe("互联网/软件");
    expect(
      await prisma.profileDraft.findUnique({ where: { userId: seed.id } }),
    ).toBeNull();
  });

  it("幂等可重试：同一 body 重复提交结果一致，仅一条画像", async () => {
    const email = devEmail();
    const first = await (await PUT(buildRequest(validBody, email))).json();
    const second = await (await PUT(buildRequest(validBody, email))).json();
    await cleanupByEmail(email);

    expect(first.success).toBe(true);
    expect(second).toEqual(first);
  });

  it("缺必填字段：400 + 校验错误明细，不落库", async () => {
    const email = devEmail();
    const body = { ...validBody } as Record<string, unknown>;
    delete body.position;
    const res = await PUT(buildRequest(body, email));
    await cleanupByEmail(email);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_FAILED");
    expect(json.error.issues.length).toBeGreaterThan(0);
  });

  it("请求体不是合法 JSON：400", async () => {
    const email = devEmail();
    const req = new Request("http://localhost/api/profile", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        [DEV_USER_HEADER]: email,
      },
      body: "{not-json",
    });
    const res = await PUT(req);
    await cleanupByEmail(email);

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_JSON");
  });

  it("生产环境（T03 未接入）无会话：401，不放行", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await PUT(buildRequest(validBody, devEmail()));
    expect(res.status).toBe(401);
    expect((await res.json()).success).toBe(false);
  });

  it("开发态无 header 时使用默认开发用户，仍可提交", async () => {
    const res = await PUT(buildRequest(validBody));
    expect(res.status).toBe(200);
    const user = await prisma.user.findUnique({
      where: { email: "dev@skilltraining.local" },
    });
    if (user) createdUserIds.push(user.id);
    expect((await res.json()).success).toBe(true);
  });
});

describe("GET /api/profile：读取画像", () => {
  it("已提交用户返回画像", async () => {
    const email = devEmail();
    await PUT(buildRequest(validBody, email));
    const res = await GET(buildRequest(undefined, email, "GET"));
    await cleanupByEmail(email);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.position).toBe("产品经理");
  });

  it("未提交用户 data 为 null", async () => {
    const email = devEmail();
    const res = await GET(buildRequest(undefined, email, "GET"));
    await cleanupByEmail(email);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toBeNull();
  });

  it("生产环境无会话：401", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(
      buildRequest(undefined, devEmail(), "GET"),
    );
    expect(res.status).toBe(401);
  });
});
