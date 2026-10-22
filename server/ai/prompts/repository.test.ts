import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import {
  findActivePromptVersion,
  insertEvalRun,
  insertPromptVersion,
  listPromptVersions,
  registerPromptVersion,
  rollbackPrompt,
  transitionPromptStatus,
} from "./repository";
import { serializePromptContent } from "./registry";

// prompt_versions 表读写集成测试（T28 / D31 切片 1）：真实测试库（skilltraining_test，
// pretest 已 migrate deploy 新表）；按 name 后缀隔离，用后清理，不影响其他测试文件。

const prisma = new PrismaClient();
const NAME = `test-prompt-${Date.now()}`;
const OTHER_NAME = `${NAME}-other`;

const contentA = serializePromptContent({ system: "系统A {{slot}}", user: "用户A" });
const contentB = serializePromptContent({ system: "系统B {{slot}}", user: "用户B" });

afterAll(async () => {
  await prisma.promptVersion.deleteMany({ where: { name: { in: [NAME, OTHER_NAME] } } });
  await prisma.$disconnect();
});

describe("insertPromptVersion / listPromptVersions / findActivePromptVersion", () => {
  it("登记默认 draft；按 name 列出（createdAt 升序）；无 active 时 findActive 返回 null", async () => {
    const created = await insertPromptVersion(prisma, {
      name: NAME,
      version: "v1",
      content: contentA,
      contentHash: "hash-a",
    });
    expect(created.status).toBe("draft");
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeInstanceOf(Date);

    const list = await listPromptVersions(prisma, NAME);
    expect(list.map((v) => v.version)).toEqual(["v1"]);
    expect(await findActivePromptVersion(prisma, NAME)).toBeNull();
  });

  it("同 name+version 重复登记同 contentHash：幂等返回既有行，不产生重复", async () => {
    const first = await registerPromptVersion(prisma, {
      name: NAME,
      version: "v2",
      content: contentB,
      contentHash: "hash-b",
    });
    const again = await registerPromptVersion(prisma, {
      name: NAME,
      version: "v2",
      content: contentB,
      contentHash: "hash-b",
    });
    expect(again.id).toBe(first.id);
    expect((await listPromptVersions(prisma, NAME)).filter((v) => v.version === "v2")).toHaveLength(1);
  });

  it("同 name+version 但内容漂移（hash 不同）：拒绝并提示升版本号", async () => {
    await expect(
      registerPromptVersion(prisma, {
        name: NAME,
        version: "v2",
        content: `${contentB}-tampered`,
        contentHash: "hash-b2",
      }),
    ).rejects.toThrow(/漂移|升版本/);
  });
});

describe("状态机与唯一 active（事务保证）", () => {
  it("draft→passed→active；非法跃迁（draft→active）拒绝且行不变", async () => {
    const v = await insertPromptVersion(prisma, {
      name: NAME,
      version: "v3",
      content: contentA,
      contentHash: "hash-a",
    });
    await expect(transitionPromptStatus(prisma, v.id, "active")).rejects.toThrow(/不允许/);
    expect((await listPromptVersions(prisma, NAME)).find((x) => x.id === v.id)?.status).toBe("draft");

    const passed = await transitionPromptStatus(prisma, v.id, "passed");
    expect(passed.status).toBe("passed");
    const active = await transitionPromptStatus(prisma, v.id, "active");
    expect(active.status).toBe("active");
    expect((await findActivePromptVersion(prisma, NAME))?.id).toBe(v.id);
  });

  it("激活新版本：旧 active 自动降级 rolled_back，同 name 始终至多一个 active；其他 name 不受影响", async () => {
    // OTHER_NAME 走完整跃迁路径置 active（登记统一走状态机，无绕过）
    const other = await insertPromptVersion(prisma, {
      name: OTHER_NAME,
      version: "v1",
      content: contentA,
      contentHash: "hash-a",
    });
    await transitionPromptStatus(prisma, other.id, "passed");
    await transitionPromptStatus(prisma, other.id, "active");
    // NAME 的 v4 先 passed 再激活
    const v4 = await insertPromptVersion(prisma, {
      name: NAME,
      version: "v4",
      content: contentB,
      contentHash: "hash-b",
    });
    await transitionPromptStatus(prisma, v4.id, "passed");
    await transitionPromptStatus(prisma, v4.id, "active");

    const list = await listPromptVersions(prisma, NAME);
    expect(list.filter((v) => v.status === "active")).toHaveLength(1);
    expect(list.find((v) => v.version === "v3")?.status).toBe("rolled_back");
    // 其他 name 的 active 不受影响
    expect((await findActivePromptVersion(prisma, OTHER_NAME))?.id).toBe(other.id);
  });

  it("回滚：当前 active 降级，最近非 active 版本重新激活", async () => {
    // NAME 现状：v3 rolled_back（较早）、v4 active → 回滚应激活 v3
    const plan = await rollbackPrompt(prisma, NAME);
    const list = await listPromptVersions(prisma, NAME);
    expect(list.find((v) => v.id === plan.activateId)?.status).toBe("active");
    expect(list.find((v) => v.id === plan.deactivateId)?.status).toBe("rolled_back");
    expect(list.filter((v) => v.status === "active")).toHaveLength(1);
    expect(plan.activateId).not.toBe(plan.deactivateId);
  });
});

describe("insertEvalRun：回归留档（T28 切片 2）", () => {
  it("写入 eval_runs 并关联 prompt 版本；consistencyScore 可空", async () => {
    const pv = await registerPromptVersion(prisma, {
      name: NAME,
      version: "v9",
      content: contentA,
      contentHash: "hash-a9",
    });
    const run = await insertEvalRun(prisma, {
      promptVersionId: pv.id,
      consistencyScore: 7.9,
      report: { suite: "scoring", verdict: "passed" },
    });
    expect(run.id).toBeTruthy();
    expect(run.promptVersionId).toBe(pv.id);
    expect(run.consistencyScore).toBe(7.9);
    expect(run.report).toEqual({ suite: "scoring", verdict: "passed" });

    // consistencyScore 可空（未评口径）
    const noScore = await insertEvalRun(prisma, {
      promptVersionId: pv.id,
      consistencyScore: null,
      report: { suite: "followup", verdict: "passed" },
    });
    expect(noScore.consistencyScore).toBeNull();

    // 级联：删除版本时留档随删（测试后清理验证）
    const count = await prisma.evalRun.count({ where: { promptVersionId: pv.id } });
    expect(count).toBe(2);
  });
});

describe("draft 不抢 active（T28 调优：v2 登记纪律）", () => {
  it("新版本登记为 draft 后，同 name 的 active 仍是旧版本", async () => {
    // v8 active 先行
    const v8 = await registerPromptVersion(prisma, {
      name: NAME,
      version: "v8",
      content: contentA,
      contentHash: "hash-a8",
    });
    await transitionPromptStatus(prisma, v8.id, "passed");
    await transitionPromptStatus(prisma, v8.id, "active");
    // 新版本仅登记 draft：active 不动
    const draft = await registerPromptVersion(prisma, {
      name: NAME,
      version: "v8-next",
      content: contentB,
      contentHash: "hash-b8",
    });
    expect(draft.status).toBe("draft");
    expect((await findActivePromptVersion(prisma, NAME))?.id).toBe(v8.id);
    // draft 不可直接激活（状态机拦截）
    await expect(transitionPromptStatus(prisma, draft.id, "active")).rejects.toThrow(/不允许/);
    expect((await findActivePromptVersion(prisma, NAME))?.id).toBe(v8.id);
  });
});
