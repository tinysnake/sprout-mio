import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { CrewDelegationCard, CrewDelegationRail } from "../../contracts/delegation";
import type { ChatSession } from "../../contracts/chat";
import { crewRailExpanded, crewRailStorageKey } from "./crew-rail-state";
import { chatTimeLabel } from "./format";
import { rememberCrewReturn } from "./crew-return-anchor";

const statuses: Record<CrewDelegationCard["status"], string> = {
  queued: "排队中",
  running: "进行中",
  blocked: "等待输入",
  completed: "已完成",
  failed: "失败",
  canceling: "取消中",
  canceled: "已取消",
};

export function CrewRail({
  projectId,
  session: crewSession,
  data,
}: {
  projectId: string;
  session: Pick<ChatSession, "kind"> & { chat: { id: string; kind: "dm" | "crew" | "delegation" } };
  data: CrewDelegationRail;
}) {
  const [expanded, setExpanded] = useState(false);
  // 用户显式选择优先于宽度默认；storage 读写失败时也保留在内存里，直到切 Project。
  const chosen = useRef<boolean | null>(null);
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    const update = () => {
      if (loadedFor.current !== projectId) {
        loadedFor.current = projectId;
        chosen.current = null;
        try {
          const stored = localStorage.getItem(crewRailStorageKey(projectId));
          if (stored !== null) chosen.current = stored === "expanded";
        } catch {
          /* Storage may be disabled; keep no explicit choice. */
        }
      }
      setExpanded(chosen.current ?? crewRailExpanded(null, window.innerWidth));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [projectId]);
  if (
    crewSession.kind !== "crew" ||
    crewSession.chat.kind !== "crew" ||
    (!data.active.length && !data.needsYou.length && !data.completed.length)
  )
    return null;
  const groups = [
    { label: "需要你", cards: data.needsYou, count: data.counts.needsYou },
    { label: "进行中", cards: data.active, count: data.counts.active },
    { label: "已完成", cards: data.completed, count: data.counts.completed },
  ];
  const contentId = `crew-rail-${crewSession.chat.id}`;
  return (
    <aside aria-label="委派" data-testid="crew-rail" className="shrink-0 border-b border-border">
      <button
        type="button"
        data-testid="crew-rail-toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        className="flex w-full items-center gap-2 px-5 py-3 text-left text-xs hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => {
          const next = !expanded;
          chosen.current = next;
          setExpanded(next);
          try {
            localStorage.setItem(crewRailStorageKey(projectId), next ? "expanded" : "collapsed");
          } catch {
            /* Keep the in-memory choice. */
          }
        }}
      >
        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span className="flex-1 font-medium">委派</span>
        <span className="text-muted-foreground">进行中 {data.counts.active}</span>
        {data.counts.needsYou > 0 && <span>需要你 {data.counts.needsYou}</span>}
      </button>
      <div id={contentId} hidden={!expanded} className="max-h-[min(30rem,50dvh)] overflow-y-auto">
        {groups
          .filter((group) => group.cards.length > 0)
          .map((group) => (
            <section key={group.label} aria-label={group.label}>
              <h3 className="px-5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
                {group.label} {group.count}
              </h3>
              <ul>
                {group.cards.map((card) => (
                  <li
                    key={card.delegationId}
                    data-testid="crew-card"
                    className="border-b border-border last:border-0"
                  >
                    <Link
                      to="/projects/$projectId/chats/$chatId"
                      params={{ projectId, chatId: card.childChatId }}
                      search={{ info: undefined }}
                      data-testid="crew-card-open"
                      onClick={() => rememberCrewReturn(crewSession.chat.id)}
                      onKeyDown={(event) => {
                        if (event.key === " ") {
                          event.preventDefault();
                          event.currentTarget.click();
                        }
                      }}
                      className="block px-5 py-3 hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {card.workerProfileName}
                        </span>
                        <span data-testid="crew-card-status">
                          {card.attentionReason ? "需要你" : statuses[card.status]}
                        </span>
                      </div>
                      <p className="mt-1 break-words text-xs font-medium">{card.title}</p>
                      {(card.attentionReason || card.summary) && (
                        <p className="mt-1 line-clamp-2 break-words text-[11px] text-muted-foreground">
                          {card.attentionReason || card.summary}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-x-3 text-[10px] text-muted-foreground">
                        <span>
                          耗时 {Math.floor(card.elapsedMs / 60000)}分
                          {Math.floor(card.elapsedMs / 1000) % 60}秒
                        </span>
                        <time dateTime={card.updatedAt} title={card.updatedAt}>
                          {chatTimeLabel(card.updatedAt)}
                        </time>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
      </div>
    </aside>
  );
}
