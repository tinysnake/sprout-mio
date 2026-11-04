import { Check, Loader2, X } from "lucide-react";
import { cn } from "cn";
import type { ChatContinuationRoundView } from "../../contracts/chat-continuation";
import { Icon } from "../ui/icon";
import {
  CONTINUATION_DECISIONS,
  CONTINUATION_STATES,
  continuationAttemptText,
  continuationDuration,
  continuationTokens,
} from "../continuation/continuation-labels";

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
function linesOf(rounds: readonly ChatContinuationRoundView[]): Line[] {
  const lines: Line[] = [];
  for (const round of rounds) {
    const decision = round.result ? CONTINUATION_DECISIONS[round.result.decision] : null;
    if (!round.attempts.length) {
      lines.push({
        id: `round-${round.round}`,
        status:
          round.state === "claimed" ? "running" : round.state === "attention" ? "error" : "done",
        label: `第 ${round.round} 轮检查`,
        detail: CONTINUATION_STATES[round.state],
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
          ? continuationAttemptText(attempt.errorCode)
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
  // 进行中的尝试不报秒数：圆环在转就够说明它在跑，结束时才用落库的时长。
  const duration =
    line.status === "running"
      ? "进行中"
      : line.durationMs === null
        ? ""
        : continuationDuration(line.durationMs);
  // 会话详情只有一列窄宽：分两行写，才不会被截成「1.7k tok · 8.4 …」。
  return (
    <li className="py-1 text-[11px] leading-4">
      <div className="flex items-baseline gap-2">
        <StatusGlyph status={line.status} />
        <span className="min-w-0 flex-1 truncate text-foreground/85">{line.label}</span>
        <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground/70">
          {timeOf(line.startedAt)}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-2 pl-5 text-[10px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={line.detail ?? undefined}>
          {line.detail ?? ""}
        </span>
        <span className="shrink-0 whitespace-nowrap font-mono">
          {line.tokens !== null && `${continuationTokens(line.tokens)} tok`}
          {line.tokens !== null && duration !== "" && " · "}
          {duration}
        </span>
      </div>
    </li>
  );
}

/**
 * 对话接续的检查记录：每轮几次尝试各一行，新的在前。
 * 判定过程不改消息也不改 run，没有这份记录，页面只能显示「正在检查」四个字。
 */
export function AttemptLines({
  rounds,
  className,
}: {
  rounds: readonly ChatContinuationRoundView[] | undefined;
  className?: string;
}) {
  const lines = rounds ? linesOf(rounds) : [];
  if (!lines.length) return null;
  return (
    <ol className={cn("list-none space-y-0 p-0", className)} data-testid="continuation-lines">
      {lines.map((line) => (
        <LineRow key={line.id} line={line} />
      ))}
    </ol>
  );
}

export function ContinuationAttempts({
  rounds,
}: {
  rounds: readonly ChatContinuationRoundView[] | undefined;
}) {
  const lines = rounds ? linesOf(rounds) : [];
  if (!lines.length) return null;

  return (
    <div data-testid="continuation-activity" className="mt-3 border-t border-border pt-2">
      <p className="text-[11px] text-muted-foreground">
        {rounds && rounds.length === 1 ? (
          "本轮检查"
        ) : (
          <>
            最近{" "}
            <span data-testid="continuation-activity-count" className="font-mono">
              {rounds?.length ?? 0}
            </span>{" "}
            轮检查
          </>
        )}
      </p>
      <AttemptLines rounds={rounds} className="mt-1 max-h-56 overflow-y-auto" />
    </div>
  );
}
