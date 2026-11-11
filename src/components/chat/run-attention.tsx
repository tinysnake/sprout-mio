import type { AgentRunStatus } from "../../contracts/agent-run";
import type { RunAttentionFacts } from "../../contracts/run-attention";

export function RunAttentionNotice({
  attention,
  status,
}: {
  attention?: RunAttentionFacts;
  status: AgentRunStatus;
}) {
  if (!attention?.attentionAt) return null;
  const active = status === "running";
  const label = active
    ? attention.awaitingHandling
      ? "需要人类关注"
      : "已请 owner 关注"
    : attention.humanRequiredAt
      ? "曾需要人类关注"
      : "曾请 owner 关注";
  return (
    <div data-testid="run-attention" className="mt-1 text-[11px] text-muted-foreground">
      <span
        className={
          active && attention.awaitingHandling ? "font-medium text-status-interrupted" : undefined
        }
      >
        {label}
      </span>
      <span>
        {" "}
        · 标记于 <time dateTime={attention.attentionAt}>{attention.attentionAt}</time>
      </span>
      {active && !attention.humanNotifiedAt && (
        <span>
          {" "}
          · 人类提醒时间{" "}
          <time dateTime={attention.humanReminderAt}>{attention.humanReminderAt}</time>
        </span>
      )}
      {attention.humanNotifiedAt && (
        <span>
          {" "}
          · 已于 <time dateTime={attention.humanNotifiedAt}>{attention.humanNotifiedAt}</time>
          提醒人类{active && attention.ownerAutoAttemptsPaused ? "，owner 自动重试已暂停" : ""}
        </span>
      )}
    </div>
  );
}
