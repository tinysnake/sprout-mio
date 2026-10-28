import { useState } from "react";
import type { AppError } from "../../contracts/result";
import type { ExecutionCancellationView, ExecutionView } from "../../contracts/remote";
import { Button } from "../ui/button";
import { StatusLine } from "./machine-list";
import { cancellationDisplay, cancellationSignalFacts } from "./lease-view";
import type { ExecutionCanceller, LogConnection } from "./presentation";

const toneText = {
  success: "text-status-success",
  warning: "text-status-warning",
  muted: "text-muted-foreground",
  danger: "text-status-failed",
} as const;

/**
 * 取消是显式动作：只有点了按钮才发出，进程不会因为租约动作或时间流逝自己停。
 * 返回的取消事实单独展示，不会把执行终态改写为「已停止」。
 */
export function ExecutionCancelControl({
  execution,
  cancel,
  connection,
  cancellation,
  onCancelled,
  testId = "execution-cancel",
}: {
  execution: ExecutionView;
  cancel: ExecutionCanceller | undefined;
  connection: LogConnection;
  /** 页面上已知的取消事实：来自本页刚发出的请求，或服务端返回的既有事实。 */
  cancellation: ExecutionCancellationView | null;
  onCancelled?: (view: ExecutionCancellationView) => void;
  testId?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const terminal = execution.terminalAt !== null;

  async function run() {
    if (!cancel || pending || terminal) return;
    setPending(true);
    setError(null);
    try {
      const result = await cancel(execution.executionId);
      if (result.ok) onCancelled?.(result.data);
      else setError(result.error);
    } catch {
      // 抛错不等于取消成功：不写终态，只报没收到结果。
      setError({
        code: "cancellation_delivery_unconfirmed",
        message: "没有收到取消结果，命令可能仍在运行。",
        requestId: "unavailable",
      });
    } finally {
      setPending(false);
    }
  }

  const state = cancellation ? cancellationDisplay(cancellation) : null;

  return (
    <div data-testid={testId} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="xs"
          variant="destructive"
          data-testid={`${testId}-request`}
          loading={pending}
          disabled={!cancel || pending || terminal}
          onClick={() => void run()}
        >
          取消这次执行
        </Button>
        <span className="text-[0.6875rem] text-muted-foreground">
          {terminal ? "执行已到终态，取消不再适用。" : "取消由 Worker 执行；送达不等于已停止。"}
        </span>
      </div>
      {!connection.online && (
        <p data-testid={`${testId}-offline`} className={toneText.warning}>
          连接已断开：取消请求无法送达 Worker，此时点击不会让命令停止。
        </p>
      )}
      {state && cancellation && (
        <div
          data-testid={`${testId}-state`}
          data-cancellation-state={cancellation.state}
          data-stopped={state.stopped ? "true" : "false"}
          className="space-y-1 rounded-lg border border-border px-3 py-2"
        >
          <StatusLine label={state.label} tone={state.tone} testId={`${testId}-state-label`} />
          <p className={`text-xs leading-6 ${toneText.muted}`}>{state.detail}</p>
          <ul
            data-testid={`${testId}-signal`}
            className="space-y-0.5 text-[0.6875rem] leading-5 text-muted-foreground"
          >
            {cancellationSignalFacts(cancellation).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p data-testid={`${testId}-error`} className={toneText.danger}>
          {error.message}
          {error.code === "cancellation_already_terminal"
            ? " 该取消请求已有终态，不会重复投递。"
            : error.code === "cancellation_not_found"
              ? " 服务端没有这条取消记录，不推断为已停止。"
              : ""}
        </p>
      )}
      {!cancel && (
        <p data-testid={`${testId}-unavailable`} className="text-[0.6875rem] text-muted-foreground">
          取消入口尚未接入服务端，此处只呈现已有取消事实。
        </p>
      )}
    </div>
  );
}
