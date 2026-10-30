import { z } from "zod";

/** 错误码为封闭集合，业务错误不能临时增加字符串。 */
export const APP_ERROR_CODES = [
  "task_invalid_transition",
  "task_assignment_invalid",
  "task_record_required",
  "task_reference_forbidden",
  "task_record_immutable",
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "too_many_requests",
  "internal",
  "lease_conflict",
  "lease_result_unconfirmed",
  "lease_not_holder",
  "lease_stale_generation",
  // 按冻结决定 10 的先后登记：最新 removed 的其他操作先判，detaching 的操作再判。
  "membership_removed",
  "detach_pending",
  "lease_fencing",
  "machine_unavailable",
  "directory_unavailable",
  "remote_request_conflict",
  "remote_grant_invalid",
  "remote_run_inactive",
  "execution_log_gap",
  "execution_log_cursor_stale",
  "execution_log_unavailable",
  "cancellation_not_found",
  "cancellation_already_terminal",
  "cancellation_delivery_unconfirmed",
  // I-P5a：公共频道成员是派生事实，独立增删它的请求用这个码回绝，其他治理越权仍用 forbidden。
  "channel_membership_managed",
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
