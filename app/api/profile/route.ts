import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { getRequestUser } from "@/server/lib/request-user";
import { prisma } from "@/server/lib/prisma";
import {
  deleteProfileDraft,
  getUserProfile,
  upsertUserProfile,
} from "@/server/modules/profile/repository";
import { profileSubmitSchema } from "@/server/modules/profile/schema";

/**
 * 画像提交与读取（T04 / US-001）。
 * PUT：zod 校验 → upsert user_profiles（幂等可重试）→ 清除草稿 → 返回画像；
 * GET：读取当前用户画像（前端回填用），未提交返回 data: null。
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

  const parsed = profileSubmitSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "VALIDATION_FAILED", "问卷内容未通过校验", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const profile = await upsertUserProfile(prisma, user.id, parsed.data);
  // 提交成功后草稿即失效；deleteMany 幂等，重复提交不受影响
  await deleteProfileDraft(prisma, user.id);
  return jsonOk(profile);
}

export async function GET(request: Request) {
  const user = await getRequestUser(prisma, request);
  if (!user) return unauthorized();
  return jsonOk(await getUserProfile(prisma, user.id));
}
