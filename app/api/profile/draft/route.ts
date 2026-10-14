import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import {
  getProfileDraft,
  saveProfileDraft,
} from "@/server/modules/profile/repository";
import { profileDraftSchema } from "@/server/modules/profile/schema";

/**
 * 画像问卷草稿暂存（T04：刷新不丢）。
 * PUT：保存草稿快照（全字段可选，仅校验已填部分；upsert 幂等）；
 * GET：读取草稿，无草稿返回 data: null。
 */

export async function PUT(request: Request) {
  const user = await getRequestUser(prisma, request);
  if (!user) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "请求体不是合法 JSON");
  }

  const parsed = profileDraftSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "VALIDATION_FAILED", "草稿内容未通过校验", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  await saveProfileDraft(prisma, user.id, parsed.data);
  return jsonOk(parsed.data);
}

export async function GET(request: Request) {
  const user = await getRequestUser(prisma, request);
  if (!user) return unauthorized();
  return jsonOk(await getProfileDraft(prisma, user.id));
}
