import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi, type Mock } from "vitest";

import { triggerSessionScoring } from "./trigger";

// 后台评分触发（T36 / D38）单元测试：注入 mock 评分实现，不触数据库与 AI。
// 语义：inflight 去重（进行中的会话不重复触发）、失败仅日志不落库并释放标记
// （下一次触发自动重试）、deps 透传 ScoreSessionDeps。

const db = {} as PrismaClient;

/** 反复触发直到被接纳（标记释放是异步的，轮询保证确定性） */
async function eventuallyAccepted(
  sessionId: string,
  scoreSession: Mock<() => Promise<void>>,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    triggerSessionScoring(db, sessionId, "u-1", { scoreSession });
    if (scoreSession.mock.calls.length > 0) return;
    if (Date.now() - start > timeoutMs) throw new Error("等待进行中标记释放超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("triggerSessionScoring：inflight 去重与失败重试（T36 / D38）", () => {
  it("评分进行中重复触发被去重，完成后释放标记可再次触发", async () => {
    const gate: { release: () => void } = { release: () => {} };
    const scoreSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          gate.release = resolve;
        }),
    );

    triggerSessionScoring(db, "session-dedupe", "u-1", { scoreSession });
    triggerSessionScoring(db, "session-dedupe", "u-1", { scoreSession });
    // 调用是同步发起的：进行中第二次触发被 inflight 去重
    expect(scoreSession).toHaveBeenCalledTimes(1);

    gate.release();
    // 完成（标记释放）后再触发被接纳：scoreSession 幂等，重复评分不重复落库
    await eventuallyAccepted("session-dedupe", vi.fn(() => Promise.resolve()));
  });

  it("评分失败：仅记录日志不落库，标记释放后下一次触发自动重试", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = vi.fn(() => Promise.reject(new Error("模拟 AI 网关故障")));
      triggerSessionScoring(db, "session-retry", "u-1", { scoreSession: failing });
      expect(failing).toHaveBeenCalledTimes(1);

      const start = Date.now();
      while (consoleSpy.mock.calls.length === 0) {
        if (Date.now() - start > 1000) throw new Error("等待失败日志超时");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // 失败后标记已释放：换成功实现的下一次触发被接纳
      await eventuallyAccepted("session-retry", vi.fn(() => Promise.resolve()));
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("透传 db/sessionId/userId 与 ScoreSessionDeps 给评分实现", () => {
    const seen: unknown[][] = [];
    const scoreWithRubric = async () => ({
      dimensions: [],
      topIssue: "issue",
      nextFocus: "focus",
    });
    const scoreSession = vi.fn((...args: unknown[]) => {
      seen.push(args);
      return Promise.resolve();
    });
    triggerSessionScoring(db, "session-deps", "u-9", { scoreSession, scoreWithRubric });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe(db);
    expect(seen[0]?.[1]).toBe("session-deps");
    expect(seen[0]?.[2]).toBe("u-9");
    expect(seen[0]?.[3]).toMatchObject({ scoreWithRubric });
  });
});
