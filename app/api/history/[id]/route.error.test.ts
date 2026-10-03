import { afterEach, describe, expect, it, vi } from "vitest";

import { DEV_USER_HEADER } from "@/server/lib/dev-identity";
import { HISTORY_ERROR_CODES, HistoryError } from "@/server/modules/history/errors";

import { GET } from "./route";

// GET /api/history/[id] 错误映射测试：mock 服务层与 prisma 单例（不出网、不碰数据库）。
// 覆盖：业务错误 → 统一错误封装；非业务错误必须原样上抛（不得吞掉或错映射）。

const { getHistoryDetailMock } = vi.hoisted(() => ({
  getHistoryDetailMock: vi.fn(),
}));

vi.mock("@/server/modules/history/view", () => ({
  getHistoryDetail: getHistoryDetailMock,
}));

vi.mock("@/server/lib/prisma", () => ({
  prisma: {
    user: {
      upsert: vi.fn(async ({ where }: { where: { email: string } }) => ({
        id: "00000000-0000-4000-8000-0000000000c9",
        email: where.email,
        createdAt: new Date(),
      })),
    },
  },
}));

const SESSION_ID = "00000000-0000-4000-8000-0000000000c1";

function callDetail() {
  const request = new Request(`http://localhost/api/history/${SESSION_ID}`, {
    headers: { [DEV_USER_HEADER]: `t10-detail-error-${Date.now()}@example.com` },
  });
  return GET(request, { params: Promise.resolve({ id: SESSION_ID }) });
}

afterEach(() => {
  getHistoryDetailMock.mockReset();
});

describe("GET /api/history/:id：错误映射", () => {
  it("业务错误 SESSION_NOT_FOUND：404 统一错误封装", async () => {
    getHistoryDetailMock.mockRejectedValueOnce(
      new HistoryError(HISTORY_ERROR_CODES.SESSION_NOT_FOUND, 404, "训练记录不存在"),
    );
    const res = await callDetail();
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("SESSION_NOT_FOUND");
  });

  it("非业务错误（如数据库故障）：原样上抛，不错误映射", async () => {
    getHistoryDetailMock.mockRejectedValueOnce(new Error("db connection lost"));
    await expect(callDetail()).rejects.toThrow("db connection lost");
  });
});
