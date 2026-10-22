/**
 * prompt 运行时解析（T28 / D31 切片 1：DB 管版本状态）。
 *
 * 判定顺序：
 * 1. 进程内缓存命中 → 直接返回（V1 单实例部署前提，进程内 Map 即可——
 *    与 aiEndpointRateLimiter 同一口径；prompt 变更经状态切换生效，需重启进程刷新缓存）；
 * 2. 查 prompt_versions 表同 name 的 active 版本：
 *    - 存在且 content 可解析 → 返回 DB 内容；
 *      其 contentHash 与文件版本哈希不一致时 console.warn（漂移观测，不阻断）；
 *    - 存在但 content 非法（非 JSON canonical）→ warn 并回退文件内容；
 * 3. 无 active 记录 → 回退文件内容（保持现有测试与开发体验不变）。
 */

import type { PrismaClient } from "@prisma/client";

import { findActivePromptVersion } from "./repository.ts";
import { computeContentHash, parsePromptContent, serializePromptContent } from "./registry.ts";
import type { PromptTemplatePair } from "./template.ts";

/** 文件版 prompt 定义（prompts/scoring.v1.ts 等导出形状） */
export interface PromptFileDefinition {
  name: string;
  version: string;
  system: string;
  user: string;
}

/** 文件版本的 DB canonical 内容与哈希（漂移比对基准） */
export function filePromptContentOf(def: PromptFileDefinition): string {
  return serializePromptContent({ system: def.system, user: def.user });
}

function filePromptHashOf(def: PromptFileDefinition): string {
  return computeContentHash(filePromptContentOf(def));
}

// 进程内缓存：V1 单实例部署前提（与 server/modules/training/rate-limit.ts 的限流器同一口径），
// key = prompt name；prompt 状态切换后需重启进程生效。
const templateCache = new Map<string, PromptTemplatePair>();

/** 测试专用：清空缓存（进程内缓存的测试隔离） */
export function resetPromptTemplateCache(): void {
  templateCache.clear();
}

export async function resolvePromptTemplates(
  db: PrismaClient,
  def: PromptFileDefinition,
): Promise<PromptTemplatePair> {
  const cached = templateCache.get(def.name);
  if (cached) return cached;

  const filePair: PromptTemplatePair = { system: def.system, user: def.user };
  let resolved = filePair;
  const active = await findActivePromptVersion(db, def.name);
  if (active) {
    const parsed = parsePromptContent(active.content);
    if (!parsed) {
      console.warn(
        `[prompt] ${def.name} 的 DB active 版本内容非法（非 JSON canonical），已回退文件版本 ${def.version}`,
      );
    } else {
      resolved = parsed;
      const fileHash = filePromptHashOf(def);
      if (active.contentHash !== fileHash) {
        // 漂移观测（非硬门禁）：DB active 与 Git 文件内容不一致——通常是文件已演进但 DB 未登记新版本
        console.warn(
          `[prompt] ${def.name} 漂移：DB active（${active.version}，hash ${active.contentHash.slice(0, 12)}…）与文件版本 ${def.version}（hash ${fileHash.slice(0, 12)}…）不一致，按 DB 内容运行`,
        );
      }
    }
  }
  templateCache.set(def.name, resolved);
  return resolved;
}
