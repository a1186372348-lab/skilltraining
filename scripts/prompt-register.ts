// prompt 版本登记脚本（T28 / D31 切片 1）：把 server/ai/prompts/ 下的版本文件登记进
// prompt_versions 表（Git 管内容、DB 管版本状态）。
// 用法：
//   node --env-file=.env scripts/prompt-register.ts <name> <version>
//     登记为 draft（默认）；同 name+version+contentHash 重复登记幂等跳过；
//     同 name+version 但内容哈希不同 = 内容漂移，拒绝（内容变更必须升版本号，历史不改写）
//   可选：--mark passed   登记后跃迁为 passed（回归已通过；跃迁经状态机校验）
//   可选：--activate      跃迁为 active（要求当前 passed / rolled_back；同 name 旧 active 自动降级）
//   可选：--dry-run       只打印执行计划（当前 DB 状态 + 将执行的动作），不写库
// 示例（v1 初始化登记为 active，两步走）：
//   node --env-file=.env scripts/prompt-register.ts scoring v1 --mark passed
//   node --env-file=.env scripts/prompt-register.ts scoring v1 --activate
// 退出码：参数/未知版本/内容漂移/非法跃迁 → 1；成功（含幂等跳过）→ 0
import { prisma } from "../server/lib/prisma.ts";
import { FOLLOWUP_PROMPT_V1 } from "../server/ai/prompts/followup.v1.ts";
import { FOLLOWUP_PROMPT_V2 } from "../server/ai/prompts/followup.v2.ts";
import { FOLLOWUP_PROMPT_V3 } from "../server/ai/prompts/followup.v3.ts";
import { SCORING_PROMPT_V1 } from "../server/ai/prompts/scoring.v1.ts";
import type { PromptFileDefinition } from "../server/ai/prompts/resolver.ts";
import { computeContentHash, serializePromptContent } from "../server/ai/prompts/registry.ts";
import {
  findActivePromptVersion,
  listPromptVersions,
  registerPromptVersion,
  transitionPromptStatus,
} from "../server/ai/prompts/repository.ts";

/** 可登记的 prompt 文件清单（新增版本文件时在此挂接） */
const PROMPT_FILES: Record<string, Record<string, PromptFileDefinition>> = {
  scoring: { v1: SCORING_PROMPT_V1 },
  followup: { v1: FOLLOWUP_PROMPT_V1, v2: FOLLOWUP_PROMPT_V2, v3: FOLLOWUP_PROMPT_V3 },
};

const name = process.argv[2]?.trim();
const version = process.argv[3]?.trim();
const markIndex = process.argv.indexOf("--mark");
const markPassed = markIndex >= 0 && process.argv[markIndex + 1] === "passed";
const activate = process.argv.includes("--activate");
const dryRun = process.argv.includes("--dry-run");

if (!name || !version) {
  console.error(
    "用法：node --env-file=.env scripts/prompt-register.ts <name> <version> [--mark passed] [--activate] [--dry-run]",
  );
  console.error(`可登记：${Object.entries(PROMPT_FILES)
    .map(([n, versions]) => `${n}（${Object.keys(versions).join("/")}）`)
    .join("，")}`);
  process.exit(1);
}
const def = PROMPT_FILES[name]?.[version];
if (!def) {
  console.error(`未知 prompt 版本：${name} ${version}（请先在 scripts/prompt-register.ts 的 PROMPT_FILES 挂接版本文件）`);
  process.exit(1);
}
if (markIndex >= 0 && !markPassed) {
  console.error("--mark 只支持参数 passed");
  process.exit(1);
}

const content = serializePromptContent({ system: def.system, user: def.user });
const contentHash = computeContentHash(content);

let versions;
let activeNow;
try {
  versions = await listPromptVersions(prisma, name);
  activeNow = await findActivePromptVersion(prisma, name);
} catch (error) {
  // P2021：目标库未执行 prompt_versions 迁移（开发库迁移由主代理执行）
  if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2021") {
    console.error("目标库缺少 prompt_versions 表——请先执行 prisma migrate deploy（测试库由 npm test 的 pretest 自动准备）");
    await prisma.$disconnect();
    process.exit(1);
  }
  throw error;
}

const existing = versions.find((v) => v.version === version);

console.log(`prompt：${name} ${version}（内容哈希 ${contentHash.slice(0, 12)}…）`);
console.log(
  `当前 DB 状态：${existing ? `${existing.status}（hash ${existing.contentHash.slice(0, 12)}…）` : "未登记"}；现役 active：${activeNow ? activeNow.version : "无"}`,
);

const steps: string[] = [];
if (!existing) steps.push(`登记为 draft`);
if (existing && existing.contentHash === contentHash) steps.push("幂等跳过（内容哈希一致）");
if (existing && existing.contentHash !== contentHash) {
  console.error("内容漂移：同 name+version 已登记但哈希不一致——内容变更请升版本号，历史版本不可改写。");
  await prisma.$disconnect();
  process.exit(1);
}
if (markPassed && (!existing || existing.status === "draft")) steps.push("跃迁 draft → passed");
if (markPassed && existing && existing.status !== "draft") {
  steps.push(`跃迁 skipped（当前 ${existing.status}，无需 mark passed）`);
}
if (activate) steps.push("跃迁 → active（同 name 旧 active 自动降级 rolled_back）");
if (steps.length === 0) steps.push("无动作");

console.log(`执行计划：${steps.join("；")}`);
if (dryRun) {
  console.log("（dry-run：不写库）");
  await prisma.$disconnect();
  process.exit(0);
}

const row = await registerPromptVersion(prisma, { name, version, content, contentHash });
console.log(`登记：${row.id === existing?.id ? "幂等命中既有行" : "新建"}（status=${row.status}）`);

let current = row.status;
if (markPassed && current === "draft") {
  await transitionPromptStatus(prisma, row.id, "passed");
  current = "passed";
  console.log("已跃迁：draft → passed");
}
if (activate) {
  if (current !== "passed" && current !== "rolled_back") {
    console.error(`当前状态 ${current} 不可激活（须先 --mark passed 确认回归通过）`);
    await prisma.$disconnect();
    process.exit(1);
  }
  await transitionPromptStatus(prisma, row.id, "active");
  console.log(`已激活为 active${activeNow ? `（旧 active ${activeNow.version} 已降级 rolled_back）` : ""}。`);
  console.log("注意：运行时解析为进程内缓存（V1 单实例），激活后需重启服务进程生效。");
}
await prisma.$disconnect();
