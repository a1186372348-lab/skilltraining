import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { backfillSessionSource } from "./backfill-session-source";

const sessionId = "07d0a3e8-dc7c-49b9-9ea2-9e1b12f3ac01";
const userId = "07d0a3e8-dc7c-49b9-9ea2-9e1b12f3ac02";

describe("历史来源回填的保护边界", () => {
  it("缺少已核实的会话清单和历史截止时间时拒绝执行", async () => {
    const execute = vi.fn(async () => 0);
    const db = { $executeRaw: execute } as unknown as PrismaClient;
    await expect(backfillSessionSource(db)).rejects.toThrow(/历史|范围/);
    await expect(backfillSessionSource(db, { userId })).rejects.toThrow(/历史|范围/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("SQL 仅处理已指定的历史记录，保留新来源和带来源对象的会话", async () => {
    const execute = vi.fn(async () => 0);
    const db = { $executeRaw: execute } as unknown as PrismaClient;
    const before = new Date("2026-10-22T14:00:00.000Z");
    await backfillSessionSource(db, { userId, sessionIds: [sessionId], before } as never);
    const [strings, ...values] = execute.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join("?");
    expect(sql).toMatch(/"source_id"\s+IS\s+NULL/i);
    expect(sql).toMatch(/"source_type"\s+(?:NOT\s+IN|IN)/i);
    expect(sql).toMatch(/"started_at"\s*</i);
    expect(sql).toMatch(/"id"\s+IN/i);
    expect(values).toContain(userId);
    expect(values).toContain(before);
  });
});
