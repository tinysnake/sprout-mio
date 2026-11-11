import { cn } from "cn";
import type { AgentRunStatus, ChatRunState, ChatRunSummary } from "../../contracts/agent-run";
import type { ChatKind, Message } from "../../contracts/chat";
import type { AppResult } from "../../contracts/result";
import type { ChatContinuationData } from "../../domain/chat-continuation";
import { ContinuationStatus } from "./continuation-status";
import { RunActivityGroup } from "./run-activity";
import { RunAttentionNotice } from "./run-attention";

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
  const run = state.latest;
  if (!state.enabled) return "宿主未启用";
  if (!run) return "尚未运行";
  return RUN_STATUS_LABELS[run.status] ?? run.status;
}

export function isRunActive(state: ChatRunState): boolean {
  return state.enabled && state.active.length > 0;
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

export function SelectedRunPanel({ result }: { result: AppResult<ChatRunSummary> }) {
  if (!result.ok) {
    return (
      <p
        role="alert"
        className="shrink-0 border-b border-border px-5 py-3 text-xs text-status-failed"
      >
        {result.error.message}
      </p>
    );
  }
  const run = result.data;
  return (
    <section
      id={`selected-run-${run.id}`}
      data-testid="selected-run"
      className="shrink-0 border-b border-border px-5 py-3 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="break-all">Run {run.id}</p>
        <RunStatusBadge status={run.status} />
      </div>
      <RunAttentionNotice attention={run.attention} status={run.status} />
      <p className="mt-1 text-muted-foreground">
        排队时间 <time dateTime={run.queuedAt}>{run.queuedAt}</time>
      </p>
      {run.settledAt && (
        <p className="text-muted-foreground">
          结束时间 <time dateTime={run.settledAt}>{run.settledAt}</time>
        </p>
      )}
      {(run.errorMessage || run.stopReason) && (
        <p className="mt-1 break-words">{run.errorMessage ?? run.stopReason}</p>
      )}
    </section>
  );
}

/**
 * run 事实与未投递输入：状态、未投递条数、失败原因与错误码全部来自
 * 领域查询，pending 输入永远显示为未投递，不冒充已处理。
 * 失败块只给文案与错误码：`requestId` 是内部标识（裁定 d43），页面不展示。
 */
export function RunStatusPanel({
  state,
  messages,
  bodies,
  onRestoreDraft,
  chatKind,
  agentNames,
  onStopRun,
  stoppingRunId,
  continuation,
}: {
  state: ChatRunState;
  messages: Message[];
  /** 窗口里出现过的正文；未投递的输入被卸载后仍能还原它的内容。 */
  bodies?: ReadonlyMap<string, string>;
  /** 提供时，未投递的输入可以放回输入框重发。 */
  onRestoreDraft?: (body: string) => void;
  /** 群组与频道按 run 的所属分身分行；DM 保持单行。 */
  chatKind?: ChatKind;
  /** instanceId → 分身名，只用于展示，不参与 run 状态判断。 */
  agentNames?: ReadonlyMap<string, string>;
  /** 提供时，每个活动 run 可以单独停止。 */
  onStopRun?: (runId: string) => void;
  stoppingRunId?: string | null;
  /** 自动续接的调度与最近检查；与 run 状态分开呈现。 */
  continuation?: AppResult<ChatContinuationData>;
}) {
  const run = state.latest;
  const group = chatKind !== undefined && chatKind !== "dm";
  const active = state.active;
  const runningCount = active.filter((row) => row.status === "running").length;
  const queuedCount = active.filter((row) => row.status === "queued").length;
  const groupStatus =
    runningCount && queuedCount
      ? `${active.length} 个 Agent 进行中（${runningCount} 运行中 · ${queuedCount} 排队中）`
      : `${active.length} 个 Agent ${runningCount ? "运行中" : "排队中"}`;
  const pending = state.inputs.filter((input) => input.disposition === "pending");
  const undelivered = pending
    .map(
      (input) =>
        messages.find((message) => message.id === input.messageId)?.body ??
        bodies?.get(input.messageId),
    )
    .filter((body): body is string => Boolean(body));
  // 宿主已启用且还没有 run 时属于空闲，不占一行；其余状态与未投递事实同排一行。
  const showStatus = !state.enabled || Boolean(run) || active.length > 0;
  const activity =
    active.find((row) => row.id === run?.id)?.activity ?? active[0]?.activity ?? run?.activity;
  const restoreBody = undelivered[undelivered.length - 1];
  const showRestore = Boolean(onRestoreDraft && restoreBody);
  const failureName = run ? agentNames?.get(run.instanceId) : undefined;

  if (!showStatus && pending.length === 0 && !showRestore && !continuation) return null;

  return (
    <section
      id={
        run &&
        !messages.some((message) => message.id === run.assistantMessageId) &&
        !(group && active.some((row) => row.id === run.id))
          ? `run-${run.id}`
          : undefined
      }
      data-testid="run-status"
      className="mt-6 space-y-2 pl-10.5 max-desktop:pl-9.75"
    >
      <ContinuationStatus continuation={continuation} />
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] [&>*:not(:first-child)]:before:mr-2 [&>*:not(:first-child)]:before:text-muted-foreground [&>*:not(:first-child)]:before:content-['·']">
        {showStatus && (
          <span className="whitespace-nowrap">
            <span className="text-muted-foreground">
              {group ? "Agent 运行状态：" : "分身运行状态："}
            </span>
            <span data-testid="pi-host-status">
              {group && active.length > 0 ? groupStatus : runStatusLabel(state)}
            </span>
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
      {!(group && active.length > 0) && run && (
        <RunAttentionNotice
          attention={active.find((row) => row.id === run.id)?.attention ?? run.attention}
          status={run.status}
        />
      )}
      {group && active.length > 0 ? (
        <ul data-testid="agent-run-list" className="space-y-2">
          {active.map((row) => {
            const name = agentNames?.get(row.instanceId) ?? "Agent";
            const stopping = stoppingRunId === row.id;
            return (
              <li
                key={row.id}
                id={`run-${row.id}`}
                data-testid="agent-run-row"
                className="border-b border-border/60 pb-2 last:border-0 last:pb-0"
              >
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-secondary text-[10px] text-foreground">
                    {name.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                  <span className={cn("shrink-0 text-[10px]", STATUS_TONE[row.status])}>
                    {RUN_STATUS_LABELS[row.status] ?? row.status}
                  </span>
                  {onStopRun && (
                    <button
                      type="button"
                      data-testid="agent-run-stop"
                      disabled={Boolean(stoppingRunId)}
                      aria-label={`停止 ${name} 的 run`}
                      onClick={() => onStopRun(row.id)}
                      className="shrink-0 rounded-control border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      {stopping ? "停止中…" : "停止"}
                    </button>
                  )}
                </div>
                <RunAttentionNotice attention={row.attention} status={row.status} />
                {row.activity ? (
                  <div className="mt-1">
                    <RunActivityGroup activity={row.activity} />
                  </div>
                ) : (
                  <p className="mt-1 pl-7 text-[11px] text-muted-foreground">等待工具调用</p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        activity && <RunActivityGroup activity={activity} />
      )}
      {run?.status === "failed" && (
        <div
          role="alert"
          data-error-code={run.errorCode ?? "run_failed"}
          className="rounded-lg border border-status-failed/35 bg-destructive-soft px-3.5 py-3 text-[11px] text-status-failed"
        >
          <p data-testid="run-failure">
            {group && failureName ? `${failureName}：` : ""}
            {run.errorMessage ?? "未知失败原因"}
          </p>
          {run.errorCode && (
            <p data-testid="run-failure-code" className="mt-1 font-mono text-[11px] opacity-80">
              {run.errorCode}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
