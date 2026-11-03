import { Check, ChevronDown, Loader2, X } from "lucide-react";
import type { ChatAutomationRoundView } from "../../contracts/chat-automation";
import { Icon } from "../ui/icon";
import {
  AUTOMATION_DECISIONS,
  AUTOMATION_STATES,
  automationAttemptText,
  automationDuration,
  automationTokens,
} from "../automation/automation-labels";
import { useElapsedSeconds } from "../automation/use-elapsed";

type Line = {
  id: string;
  status: "running" | "done" | "error";
  label: string;
  detail?: string;
  startedAt: string;
  durationMs: number | null;
  tokens: number | null;
};

/** 把轮次铺成时间线：每轮几次尝试各占一行，新的在前。 */
function linesOf(rounds: readonly ChatAutomationRoundView[]): Line[] {
  const lines: Line[] = [];
  for (const round of rounds) {
    const decision = round.result ? AUTOMATION_DECISIONS[round.result.decision] : null;
    if (!round.attempts.length) {
      lines.push({
        id: `round-${round.round}`,
        status:
          round.state === "claimed" ? "running" : round.state === "attention" ? "error" : "done",
        label: `第 ${round.round} 轮检查`,
        detail: AUTOMATION_STATES[round.state],
        startedAt: round.evaluatedAt ?? "",
        durationMs: null,
        tokens: null,
      });
      continue;
    }
    for (const attempt of [...round.attempts].reverse()) {
      const usage = attempt.usage;
      const tokens =
        usage && (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) > 0
          ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
          : null;
      lines.push({
        id: `${round.round}-${attempt.attempt}`,
        status:
          attempt.outcome === null
            ? "running"
            : attempt.outcome === "retry_wait" || attempt.outcome === "attention"
              ? "error"
              : "done",
        label:
          round.attempts.length > 1
            ? `第 ${round.round} 轮 · 第 ${attempt.attempt} 次`
            : `第 ${round.round} 轮检查`,
        detail: attempt.errorCode
          ? automationAttemptText(attempt.errorCode)
          : attempt.outcome === null
            ? "正在等待判定服务回应"
            : (decision ?? undefined),
        startedAt: attempt.startedAt,
        durationMs: usage?.durationMs || null,
        tokens,
      });
    }
  }
  return lines;
}

function StatusGlyph({ status }: { status: Line["status"] }) {
  if (status === "running") {
    return <Icon as={Loader2} size={12} className="shrink-0 animate-spin text-status-running" />;
  }
  if (status === "error") {
    return <Icon as={X} size={12} className="shrink-0 text-status-failed" />;
  }
  return <Icon as={Check} size={12} className="shrink-0 text-status-success" />;
}

function timeOf(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("zh-CN", { hour12: false });
}

function LineRow({ line }: { line: Line }) {
  // 只有还在进行的尝试需要每秒重算；结束时用落库的时长，不按客户端时钟推算。
  const waited = useElapsedSeconds(line.status === "running" ? line.startedAt : null);
  const duration =
    line.status === "running"
      ? waited === null
        ? "进行中"
        : `已等待 ${waited} 秒`
      : line.durationMs === null
        ? ""
        : automationDuration(line.durationMs);
  return (
    <li className="flex min-w-0 items-baseline gap-2 py-0.5 text-[11px] leading-4">
      <StatusGlyph status={line.status} />
      <span className="shrink-0 text-foreground/85">{line.label}</span>
      {line.detail && (
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
          title={line.detail}
        >
          {line.detail}
        </span>
      )}
      <span className="ml-auto shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
        {line.tokens !== null && `${automationTokens(line.tokens)} tok · `}
        {duration}
      </span>
      <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground/70">
        {timeOf(line.startedAt)}
      </span>
    </li>
  );
}

/**
 * 自动接续的检查记录组：与 run 工作记录同形，默认收起只露最后一次检查。
 * 判定过程不改消息也不改 run，没有这份记录，页面只能显示「正在检查」四个字。
 */
export function ContinuationActivity({
  rounds,
}: {
  rounds: readonly ChatAutomationRoundView[] | undefined;
}) {
  const lines = rounds ? linesOf(rounds) : [];
  const last = lines[0];
  if (!last) return null;

  return (
    <details
      data-testid="continuation-activity"
      className="group rounded-lg border border-border bg-card text-[11px]"
    >
      <summary
        data-testid="continuation-activity-last"
        className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 [&::-webkit-details-marker]:hidden"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 group-open:hidden">
          <StatusGlyph status={last.status} />
          <span className="shrink-0 text-muted-foreground">{last.label}</span>
          {last.detail && (
            <span
              className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
              title={last.detail}
            >
              {last.detail}
            </span>
          )}
        </span>
        <span className="hidden min-w-0 flex-1 items-center gap-2 text-muted-foreground group-open:flex">
          自动检查记录
        </span>
        <span
          data-testid="continuation-activity-count"
          className="ml-auto shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground"
        >
          {lines.length} 次
        </span>
        <Icon
          as={ChevronDown}
          size={13}
          className="shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="border-t border-border px-3 py-2">
        <ol
          data-testid="continuation-activity-entries"
          className="max-h-56 list-none space-y-0 overflow-y-auto p-0"
        >
          {lines.map((line) => (
            <LineRow key={line.id} line={line} />
          ))}
        </ol>
      </div>
    </details>
  );
}
