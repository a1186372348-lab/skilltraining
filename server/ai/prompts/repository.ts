/**
 * prompt_versions 表读写（T28 / D31：DB 管版本状态）。
 *
 * - 登记（registerPromptVersion）幂等：同 name+version+contentHash 返回既有行；
 *   同 name+version 但哈希不同 = 内容漂移，拒绝并提示升版本号（内容只升版本，不改写历史）；
 * - 状态跃迁（transitionPromptStatus）经 registry 状态机校验；激活在事务内把同 name
 *   现役 active 降级为 rolled_back（同 name 至多一个 active）；
 * - 回滚（rollbackPrompt）= 事务内执行 registry.planRollback（当前 active 降级、
 *   最近非 active 版本重新激活）。
 */

import { Prisma, type EvalRun, type PrismaClient, type PromptVersion } from "@prisma/client";

import {
  assertTransition,
  planActivation,
  planRollback,
  type PromptStatus,
  type PromptVersionView,
} from "./registry.ts";

type DbClient = PrismaClient;

function toView(row: PromptVersion): PromptVersionView {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    contentHash: row.contentHash,
    status: row.status as PromptStatus,
    createdAt: row.createdAt,
  };
}

/** 登记新版本（默认 draft）；幂等规则见文件头注释 */
export async function registerPromptVersion(
  db: DbClient,
  input: { name: string; version: string; content: string; contentHash: string },
): Promise<PromptVersion> {
  const existing = await db.promptVersion.findUnique({
    where: { name_version: { name: input.name, version: input.version } },
  });
  if (existing) {
    if (existing.contentHash !== input.contentHash) {
      throw new Error(
        `prompt「${input.name}」${input.version} 已存在但内容哈希不一致（内容漂移）——内容变更请升版本号，历史版本不可改写`,
      );
    }
    return existing; // 幂等：同内容重复登记直接返回既有行
  }
  return db.promptVersion.create({
    data: {
      name: input.name,
      version: input.version,
      content: input.content,
      contentHash: input.contentHash,
      status: "draft",
    },
  });
}

export const insertPromptVersion = registerPromptVersion;

/** 按 name 列出全部版本（createdAt 升序） */
export async function listPromptVersions(db: DbClient, name: string): Promise<PromptVersionView[]> {
  const rows = await db.promptVersion.findMany({
    where: { name },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toView);
}

/** 同 name 的 active 版本；无则 null */
export async function findActivePromptVersion(
  db: DbClient,
  name: string,
): Promise<PromptVersion | null> {
  return db.promptVersion.findFirst({ where: { name, status: "active" } });
}

/** 对可序列化冲突有限重试，每次重读状态并重新制定计划。 */
async function serializable<T>(db: DbClient, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (attempt >= 2 || typeof error !== "object" || error === null || !("code" in error) || error.code !== "P2034") throw error;
    }
  }
}

/** 状态跃迁及激活计划在同一可序列化事务中完成。 */
export async function transitionPromptStatus(
  db: DbClient,
  id: string,
  to: PromptStatus,
): Promise<PromptVersion> {
  return serializable(db, async (tx) => {
    const row = await tx.promptVersion.findUnique({ where: { id } });
    if (!row) throw new Error(`prompt 版本不存在：${id}`);
    const view = toView(row);
    assertTransition(view.status, to);
    if (to === "active") {
      const rows = await tx.promptVersion.findMany({ where: { name: view.name }, orderBy: { createdAt: "asc" } });
      const plan = planActivation(rows.map(toView), view.name, id);
      if (plan.deactivateId) {
        await tx.promptVersion.update({ where: { id: plan.deactivateId }, data: { status: "rolled_back" } });
      }
    }
    return tx.promptVersion.update({ where: { id }, data: { status: to } });
  });
}

/** 回滚计划在同一可序列化事务中读取与执行。 */
export async function rollbackPrompt(
  db: DbClient,
  name: string,
): Promise<{ activateId: string; deactivateId: string }> {
  return serializable(db, async (tx) => {
    const rows = await tx.promptVersion.findMany({ where: { name }, orderBy: { createdAt: "asc" } });
    const plan = planRollback(rows.map(toView), name);
    await tx.promptVersion.update({ where: { id: plan.deactivateId }, data: { status: "rolled_back" } });
    await tx.promptVersion.update({ where: { id: plan.activateId }, data: { status: "active" } });
    return plan;
  });
}

/**
 * 回归留档（T28 / D31：eval_runs 表；每次回归门槛判定留档）。
 * consistencyScore 口径由回归脚本定义（scoring 存 MAE、followup 存放水数，见
 * scripts/prompt-regression.ts 头部注释）；report 存完整漂移报告 JSON。
 */
export async function insertEvalRun(
  db: DbClient,
  input: { promptVersionId: string; consistencyScore: number | null; report: Prisma.InputJsonValue },
): Promise<EvalRun> {
  return db.evalRun.create({
    data: {
      promptVersionId: input.promptVersionId,
      consistencyScore: input.consistencyScore,
      report: input.report,
    },
  });
}
