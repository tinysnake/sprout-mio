import { useEffect, useState } from "react";
import { assistantActionFn } from "../../server/functions/assistant";
import type { assistantPanel } from "../../domain/assistant";
import { assistantDuration, assistantTextPreview } from "../../lib/assistant-display";
import { Button } from "../ui/button";
type Panel = ReturnType<typeof assistantPanel>;
export function AssistantPanel({ chatId }: { chatId: string }) {
  return <ChatAssistantPanel key={chatId} chatId={chatId} />;
}
function ChatAssistantPanel({ chatId }: { chatId: string }) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function refresh() {
    const result = await assistantActionFn({ data: { action: "panel", chatId } });
    if (result.ok && "proposals" in result.data) setPanel(result.data);
    else if (!result.ok) setError(result.error.message);
  }
  useEffect(() => {
    let active = true;
    const tick = async () => {
      if (active) await refresh();
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [chatId]);
  async function act(data: NonNullable<Parameters<typeof assistantActionFn>[0]>["data"]) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const result = await assistantActionFn({ data });
      if (!result.ok) setError(result.error.message);
      await refresh();
    } catch {
      setError("请求失败，请重试；重试不会重复开始工作。");
    } finally {
      setPending(false);
    }
  }
  const proposals = [...(panel?.proposals ?? [])].sort(
    (a, b) =>
      Number(b.status === "pending" && !b.expired) - Number(a.status === "pending" && !a.expired),
  );
  return (
    <section
      aria-label="Assistant 工作与关注"
      className="max-h-64 space-y-3 overflow-y-auto overscroll-contain text-xs"
      data-testid="assistant-panel"
    >
      <h3 className="font-medium">Assistant 工作与关注</h3>
      {error && <p role="alert">{error}</p>}
      {proposals.map((proposal) => (
        <details
          key={proposal.id}
          data-proposal-id={proposal.id}
          open={proposal.status === "pending" && !proposal.expired ? true : undefined}
          className="rounded-control border border-border p-3"
        >
          <summary className="flex cursor-pointer flex-wrap items-center gap-2">
            <span className="font-medium">交给</span>
            <a
              className="text-muted-foreground underline"
              href={`/projects/${proposal.targetProjectId}/chats/${proposal.targetChatId}`}
            >
              {proposal.agentName}
              {proposal.targetLabel !== proposal.agentName ? ` · ${proposal.targetLabel}` : ""}
            </a>
            <span className="text-muted-foreground">
              {proposal.status === "pending" && proposal.expired
                ? "已过期"
                : { pending: "待确认", submitted: "已提交", rejected: "已拒绝", revoked: "已撤销" }[
                    proposal.status
                  ]}
            </span>
          </summary>
          <div className="mt-2 space-y-2">
            <p data-testid="assistant-proposal-summary" className="leading-relaxed">
              {assistantTextPreview(proposal.body)}
            </p>
            <details className="text-muted-foreground">
              <summary className="w-fit cursor-pointer">查看完整工作指令</summary>
              <p className="mt-2 whitespace-pre-wrap break-words">{proposal.body}</p>
            </details>
            <div className="flex flex-wrap gap-2">
              {proposal.status === "pending" && !proposal.expired && (
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-2"
                  disabled={pending}
                  onClick={() => void act({ action: "confirm", chatId, proposalId: proposal.id })}
                >
                  确认并提交工作
                </Button>
              )}
              {["pending", "submitted"].includes(proposal.status) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-2"
                  disabled={pending}
                  onClick={() => void act({ action: "revoke", chatId, proposalId: proposal.id })}
                >
                  {proposal.status === "pending" ? "拒绝" : "撤销未投递输入"}
                </Button>
              )}
            </div>
          </div>
        </details>
      ))}
      {panel?.decisions
        .filter(
          (event) =>
            event.fact.watchIntent &&
            !panel.watches.some((watch) => watch.targetChatId === event.fact.targetChatId),
        )
        .map((event) => (
          <p key={event.id}>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() =>
                void act({
                  action: "watch",
                  chatId,
                  targetProjectId: event.fact.targetProjectId,
                  targetChatId: event.fact.targetChatId,
                  active: true,
                  intervalSeconds: event.fact.intervalSeconds,
                })
              }
            >
              确认持续关注 {event.targetLabel}（每{" "}
              {assistantDuration(event.fact.intervalSeconds ?? 300)}）
            </Button>
          </p>
        ))}
      {panel?.watches.map((watch) => (
        <p key={watch.id}>
          正在关注{" "}
          <a
            className="underline"
            href={`/projects/${watch.targetProjectId}/chats/${watch.targetChatId}`}
          >
            {watch.targetLabel}
          </a>
          <span className="ml-2 text-muted-foreground">
            每 {assistantDuration(watch.intervalSeconds)}汇报一次
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-2"
            disabled={pending}
            onClick={() =>
              void act({
                action: "watch",
                chatId,
                targetProjectId: watch.targetProjectId,
                targetChatId: watch.targetChatId,
                active: false,
              })
            }
          >
            取消关注
          </Button>
        </p>
      ))}
    </section>
  );
}
