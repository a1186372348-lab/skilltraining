import { z } from "zod";

import {
  jsonError,
  jsonOk,
  unauthorized,
} from "@/server/lib/api-response";
import { ensureRequestUser } from "@/server/lib/dev-identity";
import { prisma } from "@/server/lib/prisma";
import { getHistoryList } from "@/server/modules/history/view";

/** 分页查询参数：page ≥ 1，pageSize 1~50（默认 10） */
const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
});

/**
 * GET /api/history（T10 / US-009）：训练历史列表。
 * 按日期倒序分页，data 含 items 与分页元数据（页码/每页/总数/总页数）；
 * 每项含日期、案例名、训练重点（能力标签）、有效分摘要、状态；仅返回当前用户记录。
 */
export async function GET(request: Request) {
  const user = await ensureRequestUser(prisma, request);
  if (!user) return unauthorized();

  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    return jsonError(400, "INVALID_PAGINATION", "分页参数不合法");
  }

  const { page, pageSize } = parsed.data;
  return jsonOk(await getHistoryList(prisma, user.id, page, pageSize));
}
