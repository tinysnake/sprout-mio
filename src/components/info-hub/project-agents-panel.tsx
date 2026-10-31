import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { AgentInfoView } from "../../contracts/info-hub-query";
import type { ProjectAgentsView } from "../../contracts/info-hub";
import type { AppError } from "../../contracts/result";
import type { InfoHubResult } from "../../contracts/info-hub";
import { AgentInfoPanel } from "./agent-info-panel";
import { AgentStatusFact } from "./basic-facts";
import { RunFactsBlock } from "./run-facts";

/** Project → Agents 视角：只消费 getProjectInfoHub 的视图对象，不自行查询。 */
export function ProjectAgentsPanel({
  projectId,
  view,
  loadAgentView,
}: {
  projectId: string;
  view: ProjectAgentsView;
  /** 由路由注入的 Agent 视角查询；不注入时不渲染入口，组件不自己选 transport。 */
  loadAgentView?: (agentProfileId: string) => Promise<InfoHubResult<AgentInfoView>>;
}) {
  return (
    <section data-testid="info-hub-project-agents" className="min-w-0 space-y-4">
      <h2 data-testid="info-agents-title" className="text-sm font-medium">
        Agent 成员与分身（Info Hub）
      </h2>
      {view.agents.length === 0 ? (
        <p data-testid="info-agents-empty" className="text-sm text-muted-foreground">
          这个 Project 还没有 Agent 成员。
        </p>
      ) : (
        <ul data-testid="info-agent-list" className="divide-y divide-border/60 rounded-lg border">
          {view.agents.map((agent) => (
            <li
              key={agent.agentProfileId}
              data-testid="info-agent-item"
              data-agent-profile-id={agent.agentProfileId}
              className="min-w-0 space-y-2 px-4 py-3"
            >
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <p data-testid="info-agent-name" className="font-medium">
                    {agent.name}
                  </p>
                  {/* 人设是列表里既有的身份事实，职位只是附加的第二个事实，两者都留着。 */}
                  <p
                    data-testid="info-agent-persona-summary"
                    className="text-sm text-muted-foreground break-words"
                  >
                    {agent.personaSummary || "（无人设）"}
                  </p>
                  {agent.jobTitle && (
                    <p data-testid="info-agent-job-title" className="text-xs text-muted-foreground">
                      职位：{agent.jobTitle}
                    </p>
                  )}
                  <AgentStatusFact status={agent.status} error={agent.error} />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {loadAgentView && (
                    <AgentViewToggle agentProfileId={agent.agentProfileId} load={loadAgentView} />
                  )}
                  {agent.chatId ? (
                    <Link
                      to="/projects/$projectId/chats/$chatId"
                      params={{ projectId, chatId: agent.chatId }}
                      data-testid="info-agent-dm-link"
                      data-chat-id={agent.chatId}
                      className="text-sm underline"
                    >
                      打开对话
                    </Link>
                  ) : (
                    <span data-testid="info-agent-no-dm" className="text-sm text-muted-foreground">
                      还没有对话
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <RunFactsBlock runs={view.runs} testId="info-hub-project-runs" />
    </section>
  );
}

/**
 * Agent 视角的生产入口：按需取 summary / runs / instances 三个有界查询，
 * 组装成与组件同一份 `AgentInfoView`。分身清单来自 instances 查询本身，
 * 不用「持有租约的分身」倒推。
 */
function AgentViewToggle({
  agentProfileId,
  load: fetchView,
}: {
  agentProfileId: string;
  load: (agentProfileId: string) => Promise<InfoHubResult<AgentInfoView>>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; view: AgentInfoView }
    | { kind: "error"; error: AppError }
  >({ kind: "idle" });
  const open = () => {
    if (state.kind === "loading" || state.kind === "ok") return;
    setState({ kind: "loading" });
    void fetchView(agentProfileId).then((result) => {
      setState(
        result.ok ? { kind: "ok", view: result.data } : { kind: "error", error: result.error },
      );
    });
  };
  return (
    <div className="min-w-0 space-y-2">
      <button
        type="button"
        data-testid="info-agent-view-toggle"
        data-agent-profile-id={agentProfileId}
        aria-expanded={expanded}
        className="inline-flex min-h-6 items-center text-sm underline"
        onClick={() => {
          const next = !expanded;
          setExpanded(next);
          if (next) open();
        }}
      >
        {expanded ? "收起 Agent 视角" : "查看 Agent 视角"}
      </button>
      {expanded && state.kind === "loading" && (
        <p data-testid="info-agent-view-loading" className="text-xs text-muted-foreground">
          正在读取此 Agent 的 status、活动 run 与分身清单…
        </p>
      )}
      {expanded && state.kind === "error" && (
        <p role="alert" data-testid="info-agent-view-error" className="text-xs text-destructive">
          Agent 视角读取失败：{state.error.code}（{state.error.message}）
        </p>
      )}
      {expanded && state.kind === "ok" && <AgentInfoPanel view={state.view} />}
    </div>
  );
}
