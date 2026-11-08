import { useEffect, useState } from "react";
import { assistantActionFn } from "../../server/functions/assistant";
import type { assistantPanel } from "../../domain/assistant";
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
  return (
    <section
      aria-label="Assistant 工作与关注"
      className="mb-4 space-y-3 rounded-md border border-border p-3 text-xs"
      data-testid="assistant-panel"
    >
      <h3 className="font-medium">Assistant 工作与关注</h3>
      <p className="text-muted-foreground">
        提案仅在你确认后提交。通知来自程序事实，不会唤醒工作 Agent。
      </p>
      {error && <p role="alert">{error}</p>}
      {panel?.proposals.map((proposal) => (
        <article key={proposal.id} className="space-y-2 border-t border-border pt-2">
          <p className="whitespace-pre-wrap">{proposal.body}</p>
          <a
            className="underline"
            href={`/projects/${proposal.targetProjectId}/chats/${proposal.targetChatId}`}
          >
            {proposal.targetLabel}
          </a>
          {proposal.agentName !== proposal.targetLabel && (
            <span className="ml-2">执行者：{proposal.agentName}</span>
          )}
          <span className="ml-2">
            {proposal.status === "pending" && proposal.expired
              ? "已过期"
              : { pending: "待确认", submitted: "已提交", rejected: "已拒绝", revoked: "已撤销" }[
                  proposal.status
                ]}
          </span>
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
        </article>
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
              确认持续关注 {event.targetLabel}（每 {event.fact.intervalSeconds ?? 300} 秒）
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
          <span className="ml-2 text-muted-foreground">每 {watch.intervalSeconds} 秒检查一次</span>
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
