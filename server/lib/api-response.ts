import { NextResponse } from "next/server";

/**
 * API 统一响应封装：成功 { success: true, data }，失败 { success: false, error }。
 */

export function jsonOk<T>(data: T): NextResponse {
  return NextResponse.json({ success: true, data });
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    { success: false, error: { code, message, ...extra } },
    { status },
  );
}

/** T03 登录未接入期间的统一未登录响应 */
export function unauthorized(): NextResponse {
  return jsonError(401, "UNAUTHORIZED", "未登录或登录已过期");
}
