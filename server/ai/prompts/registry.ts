/**
 * prompt 版本注册表纯函数（T28 / D31：Git 管内容、DB 管版本状态）。
 *
 * - contentHash：sha256（hex），DB active 与文件内容的漂移观测依据；
 * - DB 存取形态：content 为 JSON canonical 字符串 {system, user}（模板含 {{slot}} 插值点，
 *   见 template.ts）；serialize/parse 往返一致，非法内容 parse 返回 null（调用方回退文件版本）；
 * - 状态机：draft → passed → active → rolled_back；rolled_back → active 为回滚重上；
 *   同 name 同时至多一个 active（planActivation 降级旧 active，assertSingleActive 校验）；
 * - 回滚（planRollback）= 当前 active 降级为 rolled_back，最近创建的非 active
 *   （passed / rolled_back）版本重新置 active——无需发版（蓝图 §4）。
 */

import { createHash } from "node:crypto";

export const PROMPT_STATUSES = ["draft", "passed", "active", "rolled_back"] as const;
export type PromptStatus = (typeof PROMPT_STATUSES)[number];

/** 注册表查询侧使用的版本记录视图（与 repository 的 DB 行同形） */
export interface PromptVersionView {
  id: string;
  name: string;
  version: string;
  contentHash: string;
  status: PromptStatus;
  createdAt: Date;
}

/* ============================== content 形态与哈希 ============================== */

/** DB 存取形态：JSON canonical 字符串（key 顺序固定 system→user，哈希稳定） */
export function serializePromptContent(pair: { system: string; user: string }): string {
  return JSON.stringify({ system: pair.system, user: pair.user });
}

/** 解析 DB content：非法（非 JSON / 缺字段 / 非字符串）返回 null，调用方回退文件版本 */
export function parsePromptContent(content: string): { system: string; user: string } | null {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as { system?: unknown; user?: unknown };
  if (typeof record.system !== "string" || typeof record.user !== "string") return null;
  return { system: record.system, user: record.user };
}

/** 内容哈希（sha256 hex）：DB active 与文件版本的漂移比对依据 */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/* ============================== 状态机 ============================== */

/** 合法跃迁表：draft→passed（回归通过）、passed→active（上线）、active→rolled_back（被替换下线）、rolled_back→active（回滚重上） */
const ALLOWED_TRANSITIONS: Readonly<Record<PromptStatus, readonly PromptStatus[]>> = {
  draft: ["passed"],
  passed: ["active", "rolled_back"],
  active: ["rolled_back"],
  rolled_back: ["active"],
};

export function canTransition(from: PromptStatus, to: PromptStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] as readonly PromptStatus[]).includes(to);
}

/** 非法跃迁抛错（可读信息，供 repository / 登记脚本快速失败） */
export function assertTransition(from: PromptStatus, to: PromptStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`prompt 版本状态跃迁不允许：${from} → ${to}（合法：${ALLOWED_TRANSITIONS[from].join(" → ") || "无"}）`);
  }
}

/* ============================== 查询与激活/回滚计划 ============================== */

/** 同 name 的 active 版本；无则 null */
export function findActiveVersion(
  versions: PromptVersionView[],
  name: string,
): PromptVersionView | null {
  return versions.find((v) => v.name === name && v.status === "active") ?? null;
}

/** 不变量校验：同 name 至多一个 active（repository 写入后自检/测试断言用） */
export function assertSingleActive(versions: PromptVersionView[], name: string): void {
  const actives = versions.filter((v) => v.name === name && v.status === "active");
  if (actives.length > 1) {
    throw new Error(`prompt「${name}」存在 ${actives.length} 个 active 版本（${actives.map((v) => v.version).join(", ")}），违反唯一 active 约束`);
  }
}

export interface ActivationPlan {
  /** 待激活版本 id */
  activateId: string;
  /** 需降级为 rolled_back 的现役 active id；无现役为 null */
  deactivateId: string | null;
}

/**
 * 激活计划：目标须为 passed 或 rolled_back；同 name 现役 active 降级为 rolled_back；
 * 其他 name 的版本不受影响。
 */
export function planActivation(
  versions: PromptVersionView[],
  name: string,
  targetId: string,
): ActivationPlan {
  const target = versions.find((v) => v.id === targetId && v.name === name);
  if (!target) {
    throw new Error(`prompt 版本不存在：${name} / ${targetId}`);
  }
  if (target.status !== "passed" && target.status !== "rolled_back") {
    throw new Error(`版本 ${target.version} 状态为 ${target.status}，不可激活（须先通过回归置 passed）`);
  }
  const currentActive = findActiveVersion(versions, name);
  return {
    activateId: target.id,
    deactivateId: currentActive && currentActive.id !== target.id ? currentActive.id : null,
  };
}

export interface RollbackPlan {
  /** 重新激活的版本 id（最近创建的非 active） */
  activateId: string;
  /** 降级为 rolled_back 的当前 active id */
  deactivateId: string;
}

/**
 * 回滚计划（D31 / 蓝图 §4：线上回滚 = DB 状态切换，无需发版）：
 * 当前 active 降级为 rolled_back；最近创建的非 active（passed / rolled_back）版本重新激活。
 * 无 active 或无可回滚目标时抛错。
 */
export function planRollback(versions: PromptVersionView[], name: string): RollbackPlan {
  const currentActive = findActiveVersion(versions, name);
  if (!currentActive) {
    throw new Error(`prompt「${name}」当前无 active 版本，无可回滚`);
  }
  const candidates = versions
    .filter((v) => v.name === name && v.status !== "active")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const target = candidates[0];
  if (!target) {
    throw new Error(`prompt「${name}」没有可回滚的历史版本（passed / rolled_back）`);
  }
  return { activateId: target.id, deactivateId: currentActive.id };
}
