import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertSingleActive,
  assertTransition,
  canTransition,
  computeContentHash,
  findActiveVersion,
  parsePromptContent,
  planActivation,
  planRollback,
  serializePromptContent,
  type PromptVersionView,
} from "./registry";

// prompt 版本注册表纯函数单测（T28 / D31 切片 1）：
// contentHash 确定性、状态机合法跃迁、同 name 至多一个 active、回滚 = 切回最近非 active 版本。

function version(partial: Partial<PromptVersionView> & { id: string }): PromptVersionView {
  return {
    name: "scoring",
    version: "v1",
    contentHash: "hash",
    status: "draft",
    createdAt: new Date("2026-10-20T00:00:00Z"),
    ...partial,
  };
}

describe("computeContentHash：内容哈希（漂移观测依据）", () => {
  it("sha256 hex，确定性且随内容变化", () => {
    const content = serializePromptContent({ system: "系统", user: "用户" });
    const expected = createHash("sha256").update(content, "utf8").digest("hex");
    expect(computeContentHash(content)).toBe(expected);
    expect(computeContentHash(content)).toBe(computeContentHash(content)); // 确定性
    expect(computeContentHash(`${content}x`)).not.toBe(expected);
  });
});

describe("prompt content 序列化/解析（DB 存取形态）", () => {
  it("serialize → parse 往返一致（system/user 模板原样保留）", () => {
    const pair = { system: "系统 {{a}}", user: "用户 {{b}}" };
    const parsed = parsePromptContent(serializePromptContent(pair));
    expect(parsed).toEqual(pair);
  });

  it("非法内容（非 JSON / 缺字段 / 非字符串）返回 null（调用方回退文件版本）", () => {
    expect(parsePromptContent("不是 JSON")).toBeNull();
    expect(parsePromptContent("{}")).toBeNull();
    expect(parsePromptContent('{"system":"s"}')).toBeNull();
    expect(parsePromptContent('{"system":"s","user":42}')).toBeNull();
    expect(parsePromptContent("[]")).toBeNull();
  });
});

describe("状态机：draft→passed→active→rolled_back（D31）", () => {
  it("合法跃迁：draft→passed、passed→active、active→rolled_back、rolled_back→active（回滚重上）", () => {
    expect(canTransition("draft", "passed")).toBe(true);
    expect(canTransition("passed", "active")).toBe(true);
    expect(canTransition("active", "rolled_back")).toBe(true);
    expect(canTransition("rolled_back", "active")).toBe(true);
    expect(() => assertTransition("draft", "passed")).not.toThrow();
  });

  it("非法跃迁拒绝：draft→active、draft→rolled_back、active→passed、passed→draft 等", () => {
    for (const [from, to] of [
      ["draft", "active"],
      ["draft", "rolled_back"],
      ["draft", "draft"],
      ["passed", "draft"],
      ["passed", "passed"],
      ["active", "draft"],
      ["active", "passed"],
      ["active", "active"],
      ["rolled_back", "draft"],
      ["rolled_back", "passed"],
    ] as const) {
      expect(canTransition(from, to)).toBe(false);
      expect(() => assertTransition(from, to)).toThrow(/不允许/);
    }
  });
});

describe("同 name 至多一个 active", () => {
  it("assertSingleActive：同 name 两个 active 抛错；不同 name 互不干扰", () => {
    const dup = [
      version({ id: "a", status: "active" }),
      version({ id: "b", version: "v2", status: "active" }),
    ];
    expect(() => assertSingleActive(dup, "scoring")).toThrow(/active/);
    const ok = [
      version({ id: "a", status: "active" }),
      version({ id: "b", name: "followup", status: "active" }),
      version({ id: "c", version: "v2", status: "rolled_back" }),
    ];
    expect(() => assertSingleActive(ok, "scoring")).not.toThrow();
    expect(() => assertSingleActive(ok, "followup")).not.toThrow();
  });

  it("planActivation：激活 passed/rolled_back 版本，同 name 旧 active 降级为 rolled_back；其他 name 不动", () => {
    const versions = [
      version({ id: "old", status: "active" }),
      version({ id: "new", version: "v2", status: "passed" }),
      version({ id: "other", name: "followup", status: "active" }),
    ];
    expect(planActivation(versions, "scoring", "new")).toEqual({
      activateId: "new",
      deactivateId: "old",
    });
    // 无现役 active 时仅激活
    expect(
      planActivation([version({ id: "new", version: "v2", status: "passed" })], "scoring", "new"),
    ).toEqual({ activateId: "new", deactivateId: null });
  });

  it("planActivation：目标不存在 / 非 passed|rolled_back 状态（draft/active）拒绝", () => {
    const versions = [version({ id: "d", status: "draft" }), version({ id: "a", status: "active" })];
    expect(() => planActivation(versions, "scoring", "missing")).toThrow(/不存在/);
    expect(() => planActivation(versions, "scoring", "d")).toThrow(/不可激活|状态/);
    expect(() => planActivation(versions, "scoring", "a")).toThrow(/不可激活|状态/);
  });
});

describe("回滚 = 切回最近非 active 版本（上一 passed/rolled_back）", () => {
  it("planRollback：当前 active 降级，最近创建的非 active 版本重新激活", () => {
    const versions = [
      version({ id: "v1", status: "rolled_back", createdAt: new Date("2026-10-01T00:00:00Z") }),
      version({ id: "v2", version: "v2", status: "active", createdAt: new Date("2026-10-10T00:00:00Z") }),
      version({ id: "v15", version: "v1.5", status: "passed", createdAt: new Date("2026-10-05T00:00:00Z") }),
    ];
    // v1(10-01 rolled_back) 与 v15(10-05 passed) 候选，取最近 = v15
    expect(planRollback(versions, "scoring")).toEqual({ activateId: "v15", deactivateId: "v2" });
  });

  it("planRollback：无 active 或无可回滚目标时抛错", () => {
    expect(() => planRollback([version({ id: "d", status: "draft" })], "scoring")).toThrow();
    expect(() => planRollback([version({ id: "a", status: "active" })], "scoring")).toThrow(/回滚/);
    expect(() => planRollback([], "scoring")).toThrow();
  });

  it("findActiveVersion：返回同 name 的 active；无则 null", () => {
    const versions = [
      version({ id: "a", status: "active" }),
      version({ id: "b", name: "followup", status: "active" }),
      version({ id: "c", version: "v2", status: "passed" }),
    ];
    expect(findActiveVersion(versions, "scoring")?.id).toBe("a");
    expect(findActiveVersion(versions, "followup")?.id).toBe("b");
    expect(findActiveVersion(versions, "missing")).toBeNull();
  });
});
