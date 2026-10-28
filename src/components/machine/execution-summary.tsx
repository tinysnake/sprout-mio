import type { ReactNode } from "react";
import { cn } from "cn";
import type { ExecutionCancellationView, ExecutionView } from "../../contracts/remote";
import { ExecutionCancelControl } from "./execution-cancel";
import { EXECUTION_STATE_LABELS, shortExecutionId } from "./lease-view";
import {
  EXECUTION_ATTENTION_LABELS,
  type ExecutionAttention,
  type ExecutionMachineSummary,
  type ExecutionCanceller,
  type LogConnection,
} from "./presentation";

const toneText = {
  success: "text-status-success",
  warning: "text-status-warning",
  muted: "text-muted-foreground",
  danger: "text-status-failed",
} as const;

/**
 * 一台 Machine 的执行摘要块：机器名、总数、分段占比条与图例。
 *
 * 条内不写字，段与段之间留 2px 间隙；比例只由 `flex-grow` 决定。
 * 零值状态在 `executionSummary` 里已经省略，这里不再过滤。
 */
export function ExecutionSummaryBlock({
  summary,
  machineLabel,
  debugSlot,
  testId = "execution-summary",
}: {
  summary: ExecutionMachineSummary;
  machineLabel: string;
  /** 右下角的「调试详情」入口；抽屉内容由调用方决定。 */
  debugSlot?: ReactNode;
  testId?: string;
}) {
  const ariaLabel = summary.segments
    .map((segment) => `${segment.label} ${segment.count} 次`)
    .join("，");
  return (
    <article
      data-testid={testId}
      data-machine-id={summary.machineId}
      data-total={summary.total}
      className="min-w-0 rounded-container border border-border bg-card px-4 pt-4 pb-3"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <p data-testid={`${testId}-machine`} className="min-w-0 text-[13px] font-medium break-all">
          {machineLabel}
        </p>
        <p className="flex flex-none items-baseline gap-1.5">
          <span className="text-[0.6875rem] text-muted-foreground">共</span>
          <span
            data-testid={`${testId}-total`}
            className="text-[2.5rem] leading-none font-medium tracking-[-0.03em] tabular-nums"
          >
            {summary.total}
          </span>
          <span className="text-[0.6875rem] text-muted-foreground">次</span>
        </p>
      </div>
      <div
        data-testid={`${testId}-bar`}
        role="img"
        aria-label={`执行占比：${ariaLabel || "没有执行"}`}
        className="mt-3 flex h-2 gap-0.5 overflow-hidden rounded-[4px] bg-muted"
      >
        {summary.segments.map((segment) => (
          <span
            key={segment.key}
            data-state={segment.key}
            data-count={segment.count}
            style={{ flexGrow: segment.count }}
            className={cn("block min-w-0.5 rounded-[2px]", segment.fill)}
          />
        ))}
      </div>
      <ul
        data-testid={`${testId}-legend`}
        className="mt-3 flex flex-wrap gap-x-4 gap-y-1 p-0 text-xs"
      >
        {summary.segments.map((segment) => (
          <li key={segment.key} className="flex items-center gap-1.5 whitespace-nowrap">
            <span aria-hidden="true" className={cn("size-2 rounded-[2px]", segment.fill)} />
            <span>{segment.label}</span>
            <span className="tabular-nums text-muted-foreground">{segment.count}</span>
          </li>
        ))}
      </ul>
      {debugSlot && <div className="mt-3 flex justify-end">{debugSlot}</div>}
    </article>
  );
}

export type AttentionItem = {
  execution: ExecutionView;
  attention: ExecutionAttention;
  machineLabel: string;
};

/**
 * 「需要处理」块：只在命中事实时出现，位于计数块之上。
 * 两类分开呈现——「需要你决定」给取消入口，「等待自动收尾」只写事实，
 * 仅取消停在 `requested` 超过窗口时额外给「重试取消」。
 */
export function ExecutionAttentionList({
  items,
  canceller,
  connection,
  cancellations,
  onCancelled,
  testId = "execution-attention",
}: {
  items: readonly AttentionItem[];
  canceller?: ExecutionCanceller;
  connection: LogConnection;
  cancellations: Readonly<Record<string, ExecutionCancellationView>>;
  onCancelled?: (view: ExecutionCancellationView) => void;
  testId?: string;
}) {
  if (items.length === 0) return null;
  const decision = items.filter((item) => item.attention.kind === "decision");
  const pending = items.filter((item) => item.attention.kind === "pending");
  return (
    <section data-testid={testId} className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-xs font-medium text-status-warning">需要处理</h4>
        <span className="text-[0.6875rem] tabular-nums text-muted-foreground">
          {items.length} 条
        </span>
      </div>
      {decision.length > 0 && (
        <AttentionGroup
          title="需要你决定"
          hint="终态不会自己回来；取消走现有的 canceller。"
          items={decision}
          canceller={canceller}
          connection={connection}
          cancellations={cancellations}
          {...(onCancelled ? { onCancelled } : {})}
          testId={`${testId}-decision`}
        />
      )}
      {pending.length > 0 && (
        <AttentionGroup
          title="等待自动收尾"
          hint="这类执行没有取消按钮，只说明事实与后果。"
          items={pending}
          canceller={canceller}
          connection={connection}
          cancellations={cancellations}
          {...(onCancelled ? { onCancelled } : {})}
          testId={`${testId}-pending`}
        />
      )}
    </section>
  );
}

function AttentionGroup({
  title,
  hint,
  items,
  canceller,
  connection,
  cancellations,
  onCancelled,
  testId,
}: {
  title: string;
  hint: string;
  items: readonly AttentionItem[];
  canceller?: ExecutionCanceller;
  connection: LogConnection;
  cancellations: Readonly<Record<string, ExecutionCancellationView>>;
  onCancelled?: (view: ExecutionCancellationView) => void;
  testId: string;
}) {
  return (
    <div data-testid={testId} className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h5 className="text-[0.6875rem] font-medium">{title}</h5>
        <span className="text-[0.6875rem] text-muted-foreground">{hint}</span>
      </div>
      <ol className="space-y-2">
        {items.map((item) => (
          <li key={item.execution.executionId} className="min-w-0">
            <AttentionCard
              item={item}
              canceller={canceller}
              connection={connection}
              cancellation={cancellations[item.execution.executionId] ?? null}
              {...(onCancelled ? { onCancelled } : {})}
              testId={`${testId}-item`}
            />
          </li>
        ))}
      </ol>
    </div>
  );
}

function AttentionCard({
  item,
  canceller,
  connection,
  cancellation,
  onCancelled,
  testId,
}: {
  item: AttentionItem;
  canceller?: ExecutionCanceller;
  connection: LogConnection;
  cancellation: ExecutionCancellationView | null;
  onCancelled?: (view: ExecutionCancellationView) => void;
  testId: string;
}) {
  const { execution, attention, machineLabel } = item;
  const state = EXECUTION_STATE_LABELS[execution.state];
  const retry = attention.reason === "cancellation_unconfirmed";
  return (
    <article
      data-testid={testId}
      data-execution-id={execution.executionId}
      data-attention-kind={attention.kind}
      data-attention-reason={attention.reason}
      className={cn(
        "min-w-0 rounded-control border border-border border-l-2 bg-card px-3 py-2.5",
        attention.kind === "decision" ? "border-l-status-failed" : "border-l-status-warning",
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
        <span className="font-mono break-all">{shortExecutionId(execution.executionId)}</span>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <span className="min-w-0 break-all text-muted-foreground">{machineLabel}</span>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <span className={toneText[state.tone]}>{state.label}</span>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <span className="font-medium">{EXECUTION_ATTENTION_LABELS[attention.reason]}</span>
      </div>
      <p className="mt-1 text-[0.6875rem] leading-5 text-muted-foreground">{attention.detail}</p>
      {(attention.needsCancel || retry) && (
        <div className="mt-2">
          <ExecutionCancelControl
            execution={execution}
            cancel={canceller}
            connection={connection}
            cancellation={cancellation}
            {...(onCancelled ? { onCancelled } : {})}
            label={attention.needsCancel ? "取消这次执行" : "重试取消"}
            testId={`${testId}-cancel`}
          />
        </div>
      )}
    </article>
  );
}
