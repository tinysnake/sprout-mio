import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { Eye } from "lucide-react";
import { assistantActionFn } from "../../server/functions/assistant";
import type { assistantPanel } from "../../domain/assistant";
import { assistantDuration, assistantTextPreview } from "../../lib/assistant-display";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

type Panel = ReturnType<typeof assistantPanel>;
/**
 * 目标类型与 Project 名称由后端在 watch/决策 DTO 上补齐（targetKind / targetProjectName）。
 * 这里按可选字段消费：后端未提供时列表只少一行元信息，不影响关注与取消。
 */
type WatchTargetMeta = {
  targetKind?: "dm" | "group" | "public_channel";
  targetProjectName?: string;
};
type ActionData =
  | { action: "panel"; chatId: string }
  | { action: "confirm" | "revoke"; chatId: string; proposalId: string }
  | {
      action: "watch";
      chatId: string;
      targetProjectId: string;
      targetChatId: string;
      active: boolean;
      intervalSeconds?: number;
      /** 确认某条 watch 请求时回传该决策 id，避免旧意图被重新激活。 */
      eventId?: string;
    }
  | { action: "reject_watch"; chatId: string; eventId: string };

function watchTargetMeta(meta: WatchTargetMeta): string {
  const kind =
    meta.targetKind === "public_channel"
      ? "公共频道"
      : meta.targetKind === "group"
        ? "群组"
        : meta.targetKind === "dm"
          ? "私聊"
          : null;
  return [kind, meta.targetProjectName]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

type AssistantController = {
  chatId: string;
  panel: Panel | null;
  error: string;
  pending: boolean;
  /** 本页刚确认过的 watch 决策 id：确认后立即收起按钮，不等下一次轮询。 */
  handledDecisions: ReadonlySet<string>;
  act: (data: ActionData, decisionId?: string) => Promise<void>;
};

const AssistantContext = createContext<AssistantController | null>(null);

const watchPopupClass =
  "w-72 max-w-[calc(100vw-3rem)] rounded-container border border-border bg-popover p-2 text-popover-foreground shadow-lg outline-none";

export function AssistantPanelProvider({
  chatId,
  active,
  children,
}: {
  chatId: string;
  active: boolean;
  children: ReactNode;
}) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [handledDecisions, setHandledDecisions] = useState<ReadonlySet<string>>(() => new Set());

  async function refresh() {
    const result = await assistantActionFn({ data: { action: "panel", chatId } });
    if (result.ok && "proposals" in result.data) setPanel(result.data);
    else if (!result.ok) setError(result.error.message);
  }

  useEffect(() => {
    if (!active) return;
    let live = true;
    const tick = async () => {
      if (live) await refresh();
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, chatId]);

  async function act(data: ActionData, decisionId?: string) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const result = await assistantActionFn({ data });
      if (!result.ok) setError(result.error.message);
      else {
        const extra = new Set<string>();
        if (decisionId !== undefined) extra.add(decisionId);
        // 取消关注后，同一目标的旧确认请求立即收起；重新发起会带上新的决策 id，仍会显示。
        if (data.action === "watch" && data.active === false) {
          for (const event of panel?.decisions ?? []) {
            if (event.fact.watchIntent && event.fact.targetChatId === data.targetChatId) {
              extra.add(event.id);
            }
          }
        }
        if (extra.size > 0) {
          setHandledDecisions((prev) => {
            const next = new Set(prev);
            for (const id of extra) next.add(id);
            return next;
          });
        }
      }
      await refresh();
    } catch {
      setError("请求失败，请重试；重试不会重复开始工作。");
    } finally {
      setPending(false);
    }
  }

  const value: AssistantController | null = active
    ? { chatId, panel, error, pending, handledDecisions, act }
    : null;
  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function AssistantWatchMenu() {
  const controller = useContext(AssistantContext);
  const [open, setOpen] = useState(false);
  if (controller === null) return null;
  const { chatId, panel, pending, act } = controller;
  const watches: (Panel["watches"][number] & WatchTargetMeta)[] = panel?.watches ?? [];
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        type="button"
        data-testid="assistant-watch-menu"
        aria-label={`正在关注 ${watches.length} 个对象`}
        className="inline-flex min-h-7 shrink-0 items-center justify-center gap-1.75 rounded-control border border-transparent bg-transparent px-2 text-[0.6875rem] font-medium text-muted-foreground select-none hover:border-input focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-desktop:min-h-11"
      >
        <Icon as={Eye} />
        <span className="whitespace-nowrap">正在关注 {watches.length}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Popover.Popup className={watchPopupClass}>
            <Popover.Title className="px-2 py-1 text-[11px] text-muted-foreground">
              正在关注
            </Popover.Title>
            {watches.length === 0 ? (
              <p
                data-testid="assistant-watch-empty"
                className="px-2 py-1.5 text-xs text-muted-foreground"
              >
                暂无关注
              </p>
            ) : (
              <ul data-testid="assistant-watch-list" className="space-y-0.5">
                {watches.map((watch) => {
                  const meta = watchTargetMeta(watch);
                  return (
                    <li
                      key={watch.id}
                      className="flex items-start gap-2 rounded-control px-2 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <a
                          href={`/projects/${watch.targetProjectId}/chats/${watch.targetChatId}`}
                          title={watch.targetLabel}
                          className="block truncate text-xs underline decoration-input underline-offset-3 hover:decoration-foreground"
                        >
                          {watch.targetLabel}
                        </a>
                        {meta.length > 0 && (
                          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                            {meta}
                          </p>
                        )}
                      </div>
                      <span className="shrink-0 text-[10px] whitespace-nowrap text-muted-foreground">
                        每 {assistantDuration(watch.intervalSeconds)}汇报一次
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid="assistant-watch-cancel"
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
                    </li>
                  );
                })}
              </ul>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function AssistantPendingBar() {
  const controller = useContext(AssistantContext);
  if (controller === null) return null;
  const { panel, error, pending, handledDecisions, act } = controller;
  const chatId = controller.chatId;
  const proposals = (panel?.proposals ?? []).filter(
    (proposal) => proposal.status === "pending" && !proposal.expired,
  );
  const activeTargets = new Set((panel?.watches ?? []).map((watch) => watch.targetChatId));
  const watchRequests = (panel?.decisions ?? []).filter(
    (event) =>
      event.fact.watchIntent &&
      !handledDecisions.has(event.id) &&
      !activeTargets.has(event.fact.targetChatId),
  );
  if (proposals.length === 0 && watchRequests.length === 0 && error.length === 0) return null;
  return (
    <div
      data-testid="assistant-composer-panel"
      className="shrink-0 border-t border-border bg-background px-6 py-3 max-desktop:px-3"
    >
      <section
        aria-label="Assistant 工作与关注"
        data-testid="assistant-panel"
        className="max-h-64 space-y-3 overflow-y-auto overscroll-contain text-xs"
      >
        {error && <p role="alert">{error}</p>}
        {proposals.map((proposal) => (
          <details
            key={proposal.id}
            data-proposal-id={proposal.id}
            open
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
              <span className="text-muted-foreground">待确认</span>
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
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-2"
                  disabled={pending}
                  onClick={() => void act({ action: "confirm", chatId, proposalId: proposal.id })}
                >
                  确认并提交工作
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-2"
                  disabled={pending}
                  onClick={() => void act({ action: "revoke", chatId, proposalId: proposal.id })}
                >
                  拒绝
                </Button>
              </div>
            </div>
          </details>
        ))}
        {watchRequests.map((event) => (
          <div key={event.id} className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() =>
                void act(
                  {
                    action: "watch",
                    chatId,
                    targetProjectId: event.fact.targetProjectId,
                    targetChatId: event.fact.targetChatId,
                    active: true,
                    intervalSeconds: event.fact.intervalSeconds,
                    eventId: event.id,
                  },
                  event.id,
                )
              }
            >
              确认持续关注 {event.targetLabel}（每{" "}
              {assistantDuration(event.fact.intervalSeconds ?? 300)}）
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="assistant-watch-reject"
              disabled={pending}
              onClick={() =>
                void act({ action: "reject_watch", chatId, eventId: event.id }, event.id)
              }
            >
              拒绝
            </Button>
          </div>
        ))}
      </section>
    </div>
  );
}
