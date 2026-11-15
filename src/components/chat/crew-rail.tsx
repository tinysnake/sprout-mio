import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "cn";
import type { CrewDelegationCard, CrewDelegationRail } from "../../contracts/delegation";
import type { ChatSession } from "../../contracts/chat";
import { crewRailExpanded, crewRailStorageKey, crewVisibleInactiveCount } from "./crew-rail-state";
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

const statusTones: Record<CrewDelegationCard["status"], string> = {
  queued: "text-status-warning",
  running: "text-status-success",
  blocked: "text-status-warning",
  completed: "text-status-success",
  failed: "text-status-failed",
  canceling: "text-status-warning",
  canceled: "text-muted-foreground",
};

function DelegationCard({
  projectId,
  crewChatId,
  card,
}: {
  projectId: string;
  crewChatId: string;
  card: CrewDelegationCard;
}) {
  const attention = card.attentionReason !== null;
  const running = card.status === "running" && !attention;
  return (
    <li data-testid="crew-card" className="border-b border-border last:border-0">
      <Link
        to="/projects/$projectId/chats/$chatId"
        params={{ projectId, chatId: card.childChatId }}
        search={{ info: undefined }}
        data-testid="crew-card-open"
        onClick={() => rememberCrewReturn(crewChatId)}
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
          <span
            data-testid="crew-card-status"
            data-status={card.status}
            data-attention={attention ? "true" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 font-medium",
              attention && card.status !== "blocked"
                ? "text-status-failed"
                : statusTones[card.status],
            )}
          >
            {running && (
              <span
                data-testid="crew-card-pulse"
                aria-hidden="true"
                className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
              />
            )}
            {attention ? "需要你" : statuses[card.status]}
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
            耗时 {Math.floor(card.elapsedMs / 60000)}分{Math.floor(card.elapsedMs / 1000) % 60}秒
          </span>
          <time dateTime={card.updatedAt} title={card.updatedAt}>
            {chatTimeLabel(card.updatedAt)}
          </time>
        </div>
      </Link>
    </li>
  );
}

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
  const [historyExpanded, setHistoryExpanded] = useState(false);
  // 用户显式选择优先于宽度默认；storage 读写失败时也保留在内存里，直到切 Project。
  const chosen = useRef<boolean | null>(null);
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    const update = () => {
      if (loadedFor.current !== projectId) {
        loadedFor.current = projectId;
        chosen.current = null;
        setHistoryExpanded(false);
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
    (!data.active.length && !data.inactive.length)
  )
    return null;
  const visibleInactive = crewVisibleInactiveCount(data.active.length, data.inactive.length);
  const recentInactive = data.inactive.slice(0, visibleInactive);
  const historicalInactive = data.inactive.slice(visibleInactive);
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
        {data.counts.needsYou > 0 && (
          <span className="text-status-warning">需处理 {data.counts.needsYou}</span>
        )}
      </button>
      <div id={contentId} hidden={!expanded} className="max-h-[min(30rem,50dvh)] overflow-y-auto">
        {data.active.length > 0 && (
          <section aria-label="进行中的委派">
            <h3 className="px-5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
              进行中的委派 {data.counts.active}
            </h3>
            <ul>
              {data.active.map((card) => (
                <DelegationCard
                  key={card.delegationId}
                  projectId={projectId}
                  crewChatId={crewSession.chat.id}
                  card={card}
                />
              ))}
            </ul>
          </section>
        )}
        {data.inactive.length > 0 && (
          <section aria-label="非进行中的委派">
            <h3 className="px-5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
              非进行中的委派 {data.counts.inactive}
            </h3>
            {recentInactive.length > 0 && (
              <ul>
                {recentInactive.map((card) => (
                  <DelegationCard
                    key={card.delegationId}
                    projectId={projectId}
                    crewChatId={crewSession.chat.id}
                    card={card}
                  />
                ))}
              </ul>
            )}
            {historicalInactive.length > 0 && (
              <>
                <button
                  type="button"
                  data-testid="crew-history-toggle"
                  aria-expanded={historyExpanded}
                  aria-controls={`${contentId}-history`}
                  className="flex w-full items-center gap-2 border-b border-border px-5 py-2.5 text-left text-[11px] text-muted-foreground hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => setHistoryExpanded((current) => !current)}
                >
                  {historyExpanded ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                  <span className="flex-1">{historyExpanded ? "收起历史委派" : "历史委派"}</span>
                  <span>{historicalInactive.length}</span>
                </button>
                <ul id={`${contentId}-history`} aria-label="历史委派" hidden={!historyExpanded}>
                  {historicalInactive.map((card) => (
                    <DelegationCard
                      key={card.delegationId}
                      projectId={projectId}
                      crewChatId={crewSession.chat.id}
                      card={card}
                    />
                  ))}
                </ul>
              </>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}
