import { z } from "zod";
import { jsonError, jsonOk, unauthorized } from "@/server/lib/api-response";
import { prisma } from "@/server/lib/prisma";
import { getRequestUser } from "@/server/lib/request-user";
import { UserTransactionError } from "@/server/lib/user-transaction";
import { FixedWindowRateLimiter } from "@/server/modules/auth/rate-limiter";
import { getStageOverview, startRetest, StageError, type RetestStart, type StageOverview } from "@/server/modules/stages";

export interface StageRouteDependencies {
  getUser(request: Request): Promise<{ id: string } | null>;
  overview(userId: string): Promise<StageOverview>;
  start(userId: string, triggerId: string): Promise<RetestStart>;
}

const defaults: StageRouteDependencies = {
  getUser: request => getRequestUser(prisma, request),
  overview: userId => getStageOverview(prisma, userId),
  start: (userId, triggerId) => startRetest(prisma, userId, triggerId),
};
const startSchema = z.strictObject({ triggerId: z.string().uuid() });
const stageRateLimiter = new FixedWindowRateLimiter({
  windowMs: 60_000,
  max: 30,
  now: () => Date.now(),
});

function rateLimit(userId: string, endpoint: "overview" | "start"): Response | null {
  const limit = stageRateLimiter.check(`${endpoint}:${userId}`);
  if (limit.allowed) return null;
  const response = jsonError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试", {
    retryAfterSeconds: limit.retryAfterSeconds,
  });
  response.headers.set("Retry-After", String(limit.retryAfterSeconds));
  return response;
}

async function responseFor(action: () => Promise<unknown>): Promise<Response> {
  try { return jsonOk(await action()); }
  catch (error) {
    if (error instanceof StageError) return jsonError(error.httpStatus, error.code, error.message);
    if (error instanceof UserTransactionError) return unauthorized();
    console.error("[stages] request failed", { name: error instanceof Error ? error.name : "UnknownError" });
    return jsonError(500, "INTERNAL_ERROR", "阶段信息暂不可用");
  }
}

export function createStageHandlers(dependencies: StageRouteDependencies = defaults) {
  async function overview(request: Request): Promise<Response> {
    const user = await dependencies.getUser(request);
    if (!user) return unauthorized();
    const limited = rateLimit(user.id, "overview");
    if (limited) return limited;
    return responseFor(() => dependencies.overview(user.id));
  }

  async function start(request: Request): Promise<Response> {
    const user = await dependencies.getUser(request);
    if (!user) return unauthorized();
    const limited = rateLimit(user.id, "start");
    if (limited) return limited;
    let input: unknown;
    try { input = await request.json(); }
    catch { return jsonError(400, "INVALID_JSON", "请求体不是合法 JSON"); }
    const parsed = startSchema.safeParse(input);
    if (!parsed.success) return jsonError(400, "VALIDATION_FAILED", "复测编号无效");
    return responseFor(() => dependencies.start(user.id, parsed.data.triggerId));
  }
  return { overview, start };
}
