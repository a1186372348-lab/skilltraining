import { z } from "zod";

/** API 入参 zod schema（Prd.md 3.5：所有 API 入参经 zod 验证） */

export const sendLinkRequestSchema = z.object({
  email: z.email("请输入有效的邮箱地址").max(254, "邮箱长度超出限制"),
});

export const verifyTokenQuerySchema = z.string().min(1).max(512);

export type SendLinkRequest = z.infer<typeof sendLinkRequestSchema>;
