import { cn } from "cn";
import type { AppError } from "../../contracts/result";

/**
 * Chat 页面的失败提示：只给可读文案与错误码，不显示 `requestId`。
 * 需要按请求追查时走 `/api/diagnostics` 或执行日志详情；页面不再把内部请求标识
 * 摊在使用者面前。它与 `ResultError` 的差别只有这一行，因此不复用那一个组件，
 * 也不改动其他页面仍在用的诊断呈现。
 */
export function ChatErrorNotice({
  error,
  testId,
  className,
}: {
  error: AppError;
  testId: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      data-error-code={error.code}
      className={cn(
        "rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive",
        className,
      )}
    >
      <p>{error.message}</p>
      <p className="mt-1 font-mono text-xs opacity-80">{error.code}</p>
    </div>
  );
}
