import { Check, Loader2, X } from "lucide-react";
import { cn } from "cn";
import type { ChatContinuationView } from "../../contracts/chat-continuation";
import type { AppResult } from "../../contracts/result";
import type { WakeUsage } from "../../contracts/wake-evaluation";
import type { ChatContinuationData } from "../../domain/chat-continuation";
import {
  CONTINUATION_DECISIONS,
  CONTINUATION_STATES,
  continuationDuration,
  continuationFailureText,
  continuationTokens,
} from "../continuation/continuation-labels";
import { chatTimeLabel } from "./format";
import { Icon } from "../ui/icon";

type Tone = "idle" | "active" | "attention" | "off";

/** 这行文字在说哪件事：判定在跑，还是接续策略本身。两者不借用对方的名字。 */
type Subject = "唤醒判定" | "对话接续";

const TONE_CLASS: Record<Tone, string> = {
  idle: "text-foreground",
  active: "text-status-running",
  attention: "text-status-failed",
  off: "text-muted-foreground",
};

/** 与 run 的活动记录同一套图示：进行中转圆环，结束打勾，失败打叉。 */
function Glyph({ tone }: { tone: Tone }) {
  if (tone === "active")
    return (
      <Icon
        as={Loader2}
        size={12}
        data-testid="continuation-spinner"
        className="mt-0.5 shrink-0 animate-spin text-status-running"
      />
    );
  if (tone === "attention")
    return <Icon as={X} size={12} className="mt-0.5 shrink-0 text-status-failed" />;
  if (tone === "idle")
    return <Icon as={Check} size={12} className="mt-0.5 shrink-0 text-status-success" />;
  return <span className="mt-1.25 size-1.5 shrink-0 rounded-full bg-muted-foreground" />;
}

function statusOf(view: ChatContinuationView): {
  tone: Tone;
  subject: Subject;
  state: string;
  label: string;
  detail?: string;
  detailTitle?: string;
} {
  const evaluation = view.latestEvaluation;
  const errorCode = view.attention?.errorCode ?? evaluation?.errorCode ?? null;
  if (view.mode === "off")
    return {
      tone: "off",
      subject: "对话接续",
      state: "off",
      label: "已关闭",
      detail: "不会安排新的自动检查",
    };
  if (view.attention || evaluation?.state === "attention")
    // 需要处理可能指向这一轮判定，也可能指向某一笔投递：按 attention 实际指向的对象命名。
    return {
      tone: "attention",
      subject: view.attention?.deliveryId ? "对话接续" : "唤醒判定",
      state: "attention",
      label: "需要处理",
      detail:
        view.attention?.reason ??
        (errorCode ? continuationFailureText(errorCode) : "对话接续需要人工确认"),
      detailTitle: errorCode ?? undefined,
    };
  if (evaluation?.state === "pending")
    return {
      tone: "active",
      subject: "唤醒判定",
      state: "pending",
      label: CONTINUATION_STATES.pending,
    };
  if (evaluation?.state === "claimed")
    return {
      tone: "active",
      subject: "唤醒判定",
      state: "claimed",
      label: CONTINUATION_STATES.claimed,
    };
  if (evaluation?.state === "retry_wait")
    return {
      tone: "attention",
      subject: "唤醒判定",
      state: "retry_wait",
      label: CONTINUATION_STATES.retry_wait,
      detail: evaluation.errorCode ? continuationFailureText(evaluation.errorCode) : undefined,
    };
  if (evaluation?.state === "decided")
    return {
      tone: "idle",
      subject: "唤醒判定",
      state: "decided",
      label: CONTINUATION_STATES.decided,
      detail: evaluation.result ? CONTINUATION_DECISIONS[evaluation.result.decision] : "暂无结论",
      detailTitle: evaluation.result?.reason,
    };
  if (evaluation?.state === "stale" || evaluation?.state === "canceled")
    return {
      tone: "off",
      subject: "唤醒判定",
      state: evaluation.state,
      label: CONTINUATION_STATES[evaluation.state],
    };
  return {
    tone: "idle",
    subject: "对话接续",
    state: "scheduled",
    label: view.nextDueAt ? "已安排下次检查" : "尚未安排检查",
  };
}

/** 一次尝试到底花了多少：时长与 token 都来自判定器回执，缺失就不编。 */
function usageSummary(usage: WakeUsage | null | undefined): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.durationMs > 0) parts.push(`耗时 ${continuationDuration(usage.durationMs)}`);
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (tokens > 0) parts.push(`${continuationTokens(tokens)} tokens`);
  if (usage.resolvedModel) parts.push(usage.resolvedModel);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * 消息下方的常显状态：判定在跑、失败了、下一步何时，以及接续策略本身是否开着。
 * 只读 `ChatContinuationView`，不重算调度，也不把「启用」说成「马上会接续」；
 * 一行里说哪件事由 `subject` 决定——判定不借用接续的名字。
 */
export function ContinuationStatus({
  continuation,
}: {
  continuation?: AppResult<ChatContinuationData>;
}) {
  if (!continuation) return null;
  if (!continuation.ok)
    return (
      <p
        data-testid="continuation-status"
        data-state="unavailable"
        className="text-[11px] text-muted-foreground"
      >
        状态不可用
      </p>
    );

  const view = continuation.data.view;
  const status = statusOf(view);
  const nextAt = view.latestEvaluation?.nextAttemptAt ?? view.nextDueAt;
  const showNext = view.mode === "enabled" && Boolean(nextAt);
  const usage = usageSummary(view.latestEvaluation?.usage);
  const attempt = view.latestEvaluation?.attempt ?? 0;

  return (
    <div
      data-testid="continuation-status"
      data-mode={view.mode}
      data-state={status.state}
      data-subject={status.subject}
      className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2 text-[11px]"
    >
      <Glyph tone={status.tone} />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 [&>*:not(:first-child)]:before:mr-2 [&>*:not(:first-child)]:before:text-muted-foreground [&>*:not(:first-child)]:before:content-['·']">
        <span className="whitespace-nowrap">
          <span className="text-muted-foreground">{status.subject}：</span>
          <span data-testid="continuation-label" className={cn(TONE_CLASS[status.tone])}>
            {status.label}
          </span>
        </span>
        {attempt > 1 && (
          <span data-testid="continuation-attempt" className="text-muted-foreground">
            第 {attempt} 次检查
          </span>
        )}
        {status.detail && (
          <span
            data-testid="continuation-detail"
            className="text-muted-foreground"
            title={status.detailTitle}
          >
            {status.detail}
          </span>
        )}
        {usage && (
          <span data-testid="continuation-usage" className="text-muted-foreground">
            {usage}
          </span>
        )}
        {showNext && (
          <span data-testid="continuation-next" className="text-muted-foreground">
            下次检查 {nextAt ? chatTimeLabel(nextAt) : "暂无记录"}
          </span>
        )}
        {view.attention?.errorCode && (
          <span
            data-error-code={view.attention.errorCode}
            className="font-mono text-[10px] opacity-70"
          >
            {view.attention.errorCode}
          </span>
        )}
      </div>
    </div>
  );
}
