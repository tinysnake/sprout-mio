import type { AppError } from "../../contracts/result";
import type { FieldErrors } from "../../contracts/project";

/**
 * 失败呈现包含错误码；requestId 只在页级 `not_found` 里露出，供用户拿去 `/api/diagnostics` 查。
 * 其他失败都对应着用户做得到的事（移除被拒、深链写错），串号只会遮住那句话。
 */
export function ResultError({
  error,
  testId = "result-error",
}: {
  error: AppError;
  testId?: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
    >
      <p>{error.message}</p>
      <p data-testid={`${testId}-meta`} className="mt-1 font-mono text-xs opacity-80">
        {error.code === "not_found" ? `${error.code} · ${error.requestId}` : error.code}
      </p>
    </div>
  );
}

/** 字段错误紧贴输入显示，键与 `createProjectInput` 的字段名一致。 */
export function FieldError({ errors, name }: { errors: FieldErrors; name: string }) {
  const message = errors[name];
  if (!message) return null;
  return (
    <p data-testid={`field-error-${name}`} className="mt-1 text-sm text-destructive">
      {message}
    </p>
  );
}
