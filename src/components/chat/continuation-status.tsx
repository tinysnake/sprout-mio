import { Check, Loader2, X } from "lucide-react";
import { cn } from "cn";
import type { ChatAutomationView } from "../../contracts/chat-automation";
import type { AppResult } from "../../contracts/result";
import type { WakeUsage } from "../../contracts/wake-evaluation";
import type { ChatAutomationData } from "../../domain/chat-automation";
import {
  AUTOMATION_DECISIONS,
  AUTOMATION_STATES,
  automationDuration,
  automationFailureText,
  automationTime,
  automationTokens,
} from "../automation/automation-labels";
import { Icon } from "../ui/icon";

type Tone = "idle" | "active" | "attention" | "off";

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

function statusOf(view: ChatAutomationView): {
  tone: Tone;
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
      state: "off",
      label: "已关闭",
      detail: "不会安排新的自动检查",
    };
  if (view.attention || evaluation?.state === "attention")
    return {
      tone: "attention",
      state: "attention",
      label: "需要处理",
      detail:
        view.attention?.reason ??
        (errorCode ? automationFailureText(errorCode) : "自动接续需要人工确认"),
      detailTitle: errorCode ?? undefined,
    };
  if (evaluation?.state === "pending")
    return { tone: "active", state: "pending", label: AUTOMATION_STATES.pending };
  if (evaluation?.state === "claimed")
    return { tone: "active", state: "claimed", label: AUTOMATION_STATES.claimed };
  if (evaluation?.state === "retry_wait")
    return {
      tone: "attention",
      state: "retry_wait",
      label: AUTOMATION_STATES.retry_wait,
      detail: evaluation.errorCode ? automationFailureText(evaluation.errorCode) : undefined,
    };
  if (evaluation?.state === "decided")
    return {
      tone: "idle",
      state: "decided",
      label: AUTOMATION_STATES.decided,
      detail: evaluation.result ? AUTOMATION_DECISIONS[evaluation.result.decision] : "暂无结论",
      detailTitle: evaluation.result?.reason,
    };
  if (evaluation?.state === "stale" || evaluation?.state === "canceled")
    return {
      tone: "off",
      state: evaluation.state,
      label: AUTOMATION_STATES[evaluation.state],
    };
  return {
    tone: "idle",
    state: "scheduled",
    label: view.nextDueAt ? "已安排下次检查" : "尚未安排检查",
  };
}

/** 一次尝试到底花了多少：时长与 token 都来自判定器回执，缺失就不编。 */
function usageSummary(usage: WakeUsage | null | undefined): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.durationMs > 0) parts.push(`耗时 ${automationDuration(usage.durationMs)}`);
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (tokens > 0) parts.push(`${automationTokens(tokens)} tokens`);
  if (usage.resolvedModel) parts.push(usage.resolvedModel);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * 自动接续在消息下方的常显状态。只读 `ChatAutomationView`，不重算调度，
 * 也不把「启用」说成「马上会接续」；逐次尝试由紧随其后的 `ContinuationActivity` 展开。
 */
export function ContinuationStatus({ automation }: { automation?: AppResult<ChatAutomationData> }) {
  if (!automation) return null;
  if (!automation.ok)
    return (
      <p
        data-testid="continuation-status"
        data-state="unavailable"
        className="text-[11px] text-muted-foreground"
      >
        自动接续：状态不可用
      </p>
    );

  const view = automation.data.view;
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
      className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2 text-[11px]"
    >
      <Glyph tone={status.tone} />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 [&>*:not(:first-child)]:before:mr-2 [&>*:not(:first-child)]:before:text-muted-foreground [&>*:not(:first-child)]:before:content-['·']">
        <span className="whitespace-nowrap">
          <span className="text-muted-foreground">自动接续：</span>
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
            下次检查 {automationTime(nextAt)}
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
