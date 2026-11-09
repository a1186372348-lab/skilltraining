import { z } from "zod";

import { jsonError, jsonOk, unauthorized } from "@/server/lib/api-response";
import { prisma } from "@/server/lib/prisma";
import { getRequestUser } from "@/server/lib/request-user";
import { UserTransactionError } from "@/server/lib/user-transaction";
import { ABILITY_DIMENSIONS } from "@/server/modules/profile/schema";
import {
  abandonPack, createPack, getActivePack, getPack, openPackItem,
  PACK_ERROR_CODES, PackError, type OpenPackItemResult, type PackDetail,
} from "@/server/modules/packs";

type PackContext = { params: Promise<{ id: string; index?: string }> };
export interface PackRouteDependencies {
  getUser(request: Request): Promise<{ id: string } | null>;
  getActive(userId: string): Promise<PackDetail | null>;
  create(userId: string, dimension: string): Promise<PackDetail>;
  get(userId: string, id: string): Promise<PackDetail>;
  abandon(userId: string, id: string, options: { confirmed: boolean }): Promise<PackDetail>;
  start(userId: string, id: string, index: number): Promise<OpenPackItemResult>;
}

const defaults: PackRouteDependencies = {
  getUser: request => getRequestUser(prisma, request),
  getActive: userId => getActivePack(prisma, userId),
  create: (userId, dimension) => createPack(prisma, userId, dimension),
  get: (userId, id) => getPack(prisma, userId, id),
  abandon: (userId, id, options) => abandonPack(prisma, userId, id, options),
  start: (userId, id, index) => openPackItem(prisma, userId, id, index),
};
const idSchema = z.uuid();
const createSchema = z.strictObject({ dimension: z.enum(ABILITY_DIMENSIONS) });
const confirmSchema = z.strictObject({ confirmed: z.boolean().optional() });
const indexSchema = z.string().regex(/^[0-4]$/).transform(Number);

async function bodyOf(request: Request): Promise<{ body: unknown; valid: boolean }> {
  try {
    const raw = await request.text();
    return { body: raw.trim() ? JSON.parse(raw) : {}, valid: true };
  } catch { return { body: null, valid: false }; }
}

async function responseFor(action: () => Promise<unknown>): Promise<Response> {
  try { return jsonOk(await action()); }
  catch (error) {
    if (error instanceof PackError) return jsonError(error.httpStatus, error.code, error.message);
    if (error instanceof UserTransactionError) return unauthorized();
    throw error;
  }
}

export function createPackHandlers(deps: PackRouteDependencies = defaults) {
  async function active(request: Request): Promise<Response> {
    const user = await deps.getUser(request);
    if (!user) return unauthorized();
    return responseFor(async () => ({ pack: await deps.getActive(user.id) }));
  }

  async function create(request: Request): Promise<Response> {
    const user = await deps.getUser(request);
    if (!user) return unauthorized();
    const input = await bodyOf(request);
    if (!input.valid) return jsonError(400, "INVALID_JSON", "请求体不是合法 JSON");
    const parsed = createSchema.safeParse(input.body);
    if (!parsed.success) return jsonError(400, "VALIDATION_FAILED", "请选择有效的能力维度");
    return responseFor(async () => ({ pack: await deps.create(user.id, parsed.data.dimension) }));
  }

  async function detail(request: Request, context: PackContext): Promise<Response> {
    const user = await deps.getUser(request);
    if (!user) return unauthorized();
    const parsed = idSchema.safeParse((await context.params).id);
    if (!parsed.success) return jsonError(400, "VALIDATION_FAILED", "训练包编号无效");
    return responseFor(async () => ({ pack: await deps.get(user.id, parsed.data) }));
  }

  async function abandon(request: Request, context: PackContext): Promise<Response> {
    const user = await deps.getUser(request);
    if (!user) return unauthorized();
    const parsed = idSchema.safeParse((await context.params).id);
    if (!parsed.success) return jsonError(400, "VALIDATION_FAILED", "训练包编号无效");
    const input = await bodyOf(request);
    if (!input.valid) return jsonError(400, "INVALID_JSON", "请求体不是合法 JSON");
    const confirmation = confirmSchema.safeParse(input.body);
    if (!confirmation.success) return jsonError(400, "VALIDATION_FAILED", "确认参数无效");
    if (!confirmation.data.confirmed) return jsonError(409, PACK_ERROR_CODES.CONFIRMATION_REQUIRED, "请确认放弃整个训练包");
    return responseFor(async () => ({ pack: await deps.abandon(user.id, parsed.data, { confirmed: true }) }));
  }

  async function start(request: Request, context: PackContext): Promise<Response> {
    const user = await deps.getUser(request);
    if (!user) return unauthorized();
    const params = await context.params;
    const id = idSchema.safeParse(params.id);
    const index = indexSchema.safeParse(params.index);
    if (!id.success || !index.success) return jsonError(400, "VALIDATION_FAILED", "训练包编号或题序无效");
    return responseFor(() => deps.start(user.id, id.data, index.data));
  }
  return { active, create, detail, abandon, start };
}
