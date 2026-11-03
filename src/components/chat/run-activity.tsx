import { Check, ChevronDown, Loader2, X } from "lucide-react";
import type { RunActivity, RunActivityStep } from "../../contracts/agent-run";
import { Icon } from "../ui/icon";

function formatDuration(step: RunActivityStep): string {
  if (step.durationMs === undefined) return "";
  return step.durationMs < 1000
    ? `${step.durationMs}ms`
    : `${(step.durationMs / 1000).toFixed(1)}s`;
}

function StatusGlyph({ status }: { status: RunActivityStep["status"] }) {
  if (status === "running") {
    return <Icon as={Loader2} size={12} className="shrink-0 animate-spin text-status-running" />;
  }
  if (status === "error") {
    return <Icon as={X} size={12} className="shrink-0 text-status-failed" />;
  }
  return <Icon as={Check} size={12} className="shrink-0 text-status-success" />;
}

function detailClass(step: RunActivityStep): string {
  return step.kind === "assistant"
    ? "min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
    : "min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground";
}

function StepLine({ step }: { step: RunActivityStep }) {
  const duration = formatDuration(step);
  return (
    <li className="flex min-w-0 items-baseline gap-2 py-0.5 text-[11px] leading-4">
      <StatusGlyph status={step.status} />
      <span className="shrink-0 text-foreground/85">{step.label}</span>
      {step.detail && (
        <span className={detailClass(step)} title={step.detail}>
          {step.detail}
        </span>
      )}
      {duration && (
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
          {duration}
        </span>
      )}
    </li>
  );
}

/**
 * 一次 run 的工作记录组：工具调用与 run 内 assistant 中间说明按发生顺序归在一起。
 * 默认收起，只露出最后一条；展开后可以看到本轮全部记录（最新在前）。
 */
export function RunActivityGroup({ activity }: { activity: RunActivity }) {
  const last = activity.entries[0];
  if (!last) return null;
  const count = activity.entries.length;

  return (
    <details
      data-testid="run-activity"
      className="group rounded-lg border border-border bg-card text-[11px]"
    >
      <summary
        data-testid="run-activity-last"
        className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 [&::-webkit-details-marker]:hidden"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 group-open:hidden">
          <StatusGlyph status={last.status} />
          <span className="shrink-0 text-muted-foreground">{last.label}</span>
          {last.detail && (
            <span className={detailClass(last)} title={last.detail}>
              {last.detail}
            </span>
          )}
        </span>
        <span className="hidden min-w-0 flex-1 items-center gap-2 text-muted-foreground group-open:flex">
          本轮工作记录
        </span>
        <span
          data-testid="run-activity-count"
          className="ml-auto shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground"
        >
          {count} 条
        </span>
        <Icon
          as={ChevronDown}
          size={13}
          className="shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="border-t border-border px-3 py-2">
        <ol
          data-testid="run-activity-entries"
          className="max-h-56 list-none space-y-0 overflow-y-auto p-0"
        >
          {activity.entries.map((step) => (
            <StepLine key={step.id} step={step} />
          ))}
        </ol>
      </div>
    </details>
  );
}
