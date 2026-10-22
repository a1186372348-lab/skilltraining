import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerPromptVersion, transitionPromptStatus } from "./repository";
import { computeContentHash, serializePromptContent } from "./registry";
import {
  resetPromptTemplateCache,
  resolvePromptTemplates,
  type PromptFileDefinition,
} from "./resolver";

// 运行时 prompt 解析集成测试（T28 / D31 切片 1）：真实测试库；
// DB active 优先 / 文件回退 / 哈希漂移仅 warn 不阻断 / 进程内缓存。
// 按 name 后缀隔离，用后清理。

const prisma = new PrismaClient();
const NAME = `test-resolver-${Date.now()}`;

/** 文件版本定义（fixture）：模板含插值点 */
const FILE_DEF: PromptFileDefinition = {
  name: NAME,
  version: "v1",
  system: "文件系统提示 {{tone}}",
  user: "文件用户提示 {{question}}",
};
const FILE_CONTENT = serializePromptContent({ system: FILE_DEF.system, user: FILE_DEF.user });
const FILE_HASH = computeContentHash(FILE_CONTENT);

/** 登记并激活一条 DB 版本（content 可异于文件） */
async function seedActive(content: string, contentHash: string): Promise<void> {
  const row = await registerPromptVersion(prisma, {
    name: NAME,
    version: "v1",
    content,
    contentHash: contentHash,
  });
  await transitionPromptStatus(prisma, row.id, "passed");
  await transitionPromptStatus(prisma, row.id, "active");
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  resetPromptTemplateCache();
  // 用例间 DB 隔离：同名历史行会让登记守卫按「内容漂移」拦截
  await prisma.promptVersion.deleteMany({ where: { name: NAME } });
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});
afterAll(async () => {
  await prisma.promptVersion.deleteMany({ where: { name: NAME } });
  await prisma.$disconnect();
});

describe("resolvePromptTemplates：DB active 优先、文件回退（T28）", () => {
  it("DB 无 active 记录：回退文件内容，不 warn", async () => {
    const resolved = await resolvePromptTemplates(prisma, FILE_DEF);
    expect(resolved).toEqual({ system: FILE_DEF.system, user: FILE_DEF.user });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("DB active 与文件一致（哈希匹配）：返回 DB 内容（与文件逐字相同），不 warn", async () => {
    await seedActive(FILE_CONTENT, FILE_HASH);
    const resolved = await resolvePromptTemplates(prisma, FILE_DEF);
    expect(resolved).toEqual({ system: FILE_DEF.system, user: FILE_DEF.user });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("DB active 与文件哈希不一致（漂移）：返回 DB 内容 + console.warn，不阻断", async () => {
    const drifted = serializePromptContent({ system: "DB 系统提示 {{tone}}", user: "DB 用户提示 {{question}}" });
    await seedActive(drifted, computeContentHash(drifted));
    const resolved = await resolvePromptTemplates(prisma, FILE_DEF);
    expect(resolved).toEqual({ system: "DB 系统提示 {{tone}}", user: "DB 用户提示 {{question}}" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain(NAME); // warn 含 prompt 名（漂移观测）
  });

  it("DB active 内容非法（非 JSON canonical）：warn 并回退文件内容", async () => {
    await seedActive("不是合法 content", "hash-x");
    const resolved = await resolvePromptTemplates(prisma, FILE_DEF);
    expect(resolved).toEqual({ system: FILE_DEF.system, user: FILE_DEF.user });
    expect(warnSpy).toHaveBeenCalled();
  });

  it("进程内缓存：同一 name 第二次解析不重复查库（V1 单实例）", async () => {
    await seedActive(FILE_CONTENT, FILE_HASH);
    const first = await resolvePromptTemplates(prisma, FILE_DEF);
    // 删掉 DB 行后再次解析：命中缓存仍返回（证明未查库）
    await prisma.promptVersion.deleteMany({ where: { name: NAME } });
    const second = await resolvePromptTemplates(prisma, FILE_DEF);
    expect(second).toEqual(first);
  });
});
