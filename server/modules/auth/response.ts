/**
 * 统一 API 响应封装：成功标识 + 数据负载 + 错误信息。
 * 形如 { ok: true, data } / { ok: false, error: { code, message } }。
 */

export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: { code: string; message: string };
}

export type ApiResponse<T> = ApiOk<T> | ApiError;

export function ok<T>(data: T): ApiOk<T> {
  return { ok: true, data };
}

export function fail(code: string, message: string): ApiError {
  return { ok: false, error: { code, message } };
}
