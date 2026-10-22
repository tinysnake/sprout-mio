import { cn } from "cn";
import type { AgentRunStatus, ChatRunState } from "../../contracts/agent-run";
import type { Message } from "../../contracts/chat";

export const RUN_STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  aborted: "已停止",
  interrupted: "已中断",
};

/** 状态色只表达事实，并始终与文字同时出现。 */
const STATUS_TONE: Record<string, string> = {
  queued: "text-status-queued",
  running: "text-status-running",
  completed: "text-status-success",
  failed: "border-status-failed/30 bg-destructive-soft text-status-failed",
  aborted: "text-status-stopped",
  interrupted: "text-status-interrupted",
};

export function runStatusLabel(state: ChatRunState): string {
  const run = state.runs.at(-1);
  if (!state.enabled) return "宿主未启用";
  if (!run) return "尚未运行";
  return RUN_STATUS_LABELS[run.status] ?? run.status;
}

export function isRunActive(state: ChatRunState): boolean {
  const run = state.runs.at(-1);
  return Boolean(state.enabled && run && (run.status === "queued" || run.status === "running"));
}

export function RunStatusBadge({ status }: { status: AgentRunStatus }) {
  return (
    <span
      data-testid="chat-run-badge"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-control border border-border px-1.75 py-0.75 text-[10px] whitespace-nowrap text-muted-foreground",
        STATUS_TONE[status],
      )}
    >
      <span className="size-1.25 shrink-0 rounded-full bg-current" />
      {RUN_STATUS_LABELS[status] ?? status}
    </span>
  );
}

/**
 * run 事实与未投递输入：状态、未投递条数、失败原因与 requestId 全部来自
 * 领域查询，pending 输入永远显示为未投递，不冒充已处理。
 */
export function RunStatusPanel({
  state,
  messages,
  onRestoreDraft,
}: {
  state: ChatRunState;
  messages: Message[];
  /** 提供时，未投递的输入可以放回输入框重发。 */
  onRestoreDraft?: (body: string) => void;
}) {
  const run = state.runs.at(-1);
  const pending = state.inputs.filter((input) => input.disposition === "pending");
  const undelivered = pending
    .map((input) => messages.find((message) => message.id === input.messageId)?.body)
    .filter((body): body is string => Boolean(body));
  // 宿主已启用且还没有 run 时属于空闲，不占一行；其余状态与未投递事实同排一行。
  const showStatus = !state.enabled || Boolean(run);
  const restoreBody = undelivered[undelivered.length - 1];
  const showRestore = Boolean(onRestoreDraft && restoreBody);

  if (!showStatus && pending.length === 0 && !showRestore) return null;

  return (
    <section data-testid="run-status" className="mt-6 space-y-2 pl-10.5 max-desktop:pl-9.75">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] [&>*:not(:first-child)]:before:mr-2 [&>*:not(:first-child)]:before:text-muted-foreground [&>*:not(:first-child)]:before:content-['·']">
        {showStatus && (
          <span className="whitespace-nowrap">
            <span className="text-muted-foreground">分身运行状态：</span>
            <span data-testid="pi-host-status">{runStatusLabel(state)}</span>
          </span>
        )}
        {pending.length > 0 && (
          <span data-testid="pending-input-count">{pending.length} 条输入未投递</span>
        )}
        {showRestore && restoreBody && (
          <button
            type="button"
            data-testid="restore-undelivered"
            onClick={() => onRestoreDraft?.(restoreBody)}
            className="text-foreground underline decoration-input underline-offset-3 hover:decoration-foreground"
          >
            恢复到输入框
          </button>
        )}
      </p>
      {run?.status === "failed" && (
        <div
          role="alert"
          className="rounded-lg border border-status-failed/35 bg-destructive-soft px-3.5 py-3 text-[11px] text-status-failed"
        >
          <p data-testid="run-failure">{run.errorMessage ?? "未知失败原因"}</p>
          <p data-testid="run-failure-request" className="mt-1 font-mono text-[11px]">
            requestId: {run.requestId}
          </p>
        </div>
      )}
    </section>
  );
}
