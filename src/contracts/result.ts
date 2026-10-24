import { z } from "zod";

/** 错误码为封闭集合，业务错误不能临时增加字符串。 */
export const APP_ERROR_CODES = [
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "too_many_requests",
  "internal",
  "lease_conflict",
  "lease_not_holder",
  "lease_stale_generation",
  "lease_fencing",
  "machine_unavailable",
  "directory_unavailable",
  "remote_request_conflict",
  "remote_grant_invalid",
  "remote_run_inactive",
] as const;
/** 只允许登记的错误码，不接受未知字符串。 */
export type AppErrorCode = (typeof APP_ERROR_CODES)[number];
/** 每个失败都有错误码、安全消息和 requestId。 */
export interface AppError {
  code: AppErrorCode;
  message: string;
  requestId: string;
}
/** 成功必有 data，失败必有 error，两个分支不能同时出现。 */
export type AppResult<T> =
  | { ok: true; data: T; requestId: string; error?: never }
  | { ok: false; error: AppError; requestId: string; data?: never };

export function ok<T>(data: T, requestId: string): AppResult<T> {
  return { ok: true, data, requestId };
}

export function fail(error: AppError): AppResult<never> {
  return { ok: false, error, requestId: error.requestId };
}

const appErrorSchema = z.object({ code: z.enum(APP_ERROR_CODES), message: z.string() });

export function toAppError(error: unknown, requestId: string): AppError {
  if (error instanceof z.ZodError) {
    return { code: "validation_failed", message: "输入校验失败", requestId };
  }
  const parsed = appErrorSchema.safeParse(error);
  if (parsed.success && parsed.data.code !== "internal") {
    return { ...parsed.data, requestId };
  }
  return { code: "internal", message: "内部错误", requestId };
}
