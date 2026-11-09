import { describe, expect, it, vi } from "vitest";
import type { UserTransaction } from "@/server/lib/user-transaction";
import { stageConsistent } from "./integrity";

const trigger = { id: "trigger", type: "retest_trigger", triggerId: null, settledAt: new Date(), eventScoreSequence: BigInt(3) };
const result = { id: "result", type: "retest_pass", triggerId: "trigger", settledAt: null, eventScoreSequence: BigInt(4) };

function context(records: unknown[], afterSequence: bigint | null | undefined): UserTransaction {
  return { userId: "user", tx: {
    stageRecord: { findMany: vi.fn().mockResolvedValue(records) },
    stageProgress: { findUnique: vi.fn().mockResolvedValue(afterSequence === undefined ? null : { afterSequence }) },
  } } as unknown as UserTransaction;
}

describe("阶段事件一致性", () => {
  it("无历史、未决和已原子结算均允许继续", async () => {
    expect(await stageConsistent(context([], undefined), "问题定义")).toBe(true);
    expect(await stageConsistent(context([{ ...trigger, settledAt: null }], null), "问题定义")).toBe(true);
    expect(await stageConsistent(context([trigger, result], BigInt(4)), "问题定义")).toBe(true);
  });

  it("缺进度、孤立结果、缺失结果、未关闭触发或水位不匹配时必须恢复", async () => {
    const cases: Array<[unknown[], bigint | null | undefined]> = [
      [[trigger], undefined], [[trigger], null], [[{ ...trigger, settledAt: null }, result], BigInt(4)],
      [[trigger, { ...result, triggerId: "other" }], BigInt(4)],
      [[trigger, { ...result, eventScoreSequence: BigInt(3) }], BigInt(3)],
      [[trigger, result], BigInt(5)], [[], BigInt(5)],
    ];
    for (const [records, boundary] of cases) expect(await stageConsistent(context(records, boundary), "问题定义")).toBe(false);
  });
});
