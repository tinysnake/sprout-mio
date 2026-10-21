import { Link } from "@tanstack/react-router";
import type { ProjectAgentsView } from "../../contracts/info-hub";
import { RunFactsBlock } from "./run-facts";

/** Project → Agents 视角：只消费 getProjectInfoHub 的视图对象，不自行查询。 */
export function ProjectAgentsPanel({
  projectId,
  view,
}: {
  projectId: string;
  view: ProjectAgentsView;
}) {
  return (
    <section
      data-testid="info-hub-project-agents"
      className="space-y-4 rounded-lg border border-dashed p-6"
    >
      <h2 data-testid="info-agents-title" className="text-lg font-semibold">
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
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="space-y-1">
                <p data-testid="info-agent-name" className="font-medium">
                  {agent.name}
                </p>
                <p
                  data-testid="info-agent-persona-summary"
                  className="text-sm text-muted-foreground"
                >
                  {agent.personaSummary || "（无人设）"}
                </p>
              </div>
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
            </li>
          ))}
        </ul>
      )}
      <RunFactsBlock runs={view.runs} testId="info-hub-project-runs" />
    </section>
  );
}
