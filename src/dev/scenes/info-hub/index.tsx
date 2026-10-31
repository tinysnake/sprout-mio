import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { ProjectContextFacts } from "../../../components/info-hub/project-context-facts";
import { AgentInfoPanel } from "../../../components/info-hub/agent-info-panel";
import { AgentStatusFact, MachineSummaryFact } from "../../../components/info-hub/basic-facts";
import { ChatFactsBlock } from "../../../components/info-hub/chat-info-panel";
import { RunFactsBlock, TurnStartContextBlock } from "../../../components/info-hub/run-facts";
import { useInfoHubPolling } from "../../../components/info-hub/use-info-hub-polling";
import {
  agentFixture,
  chatFixture,
  contextFixture,
  machineFixture,
  projectFixture,
  projectId,
} from "./fixtures";

function Page() {
  const [mode, setMode] = useState("prepared");
  const empty = mode === "empty";
  const state = useInfoHubPolling({
    input: { projectId, query: { view: "project", section: "agents", limit: 25 } },
    refresh: async (input, signal) => {
      const response = await fetch("/__fixture/refresh", {
        method: "POST",
        body: JSON.stringify(input),
        signal,
      });
      if (!response.ok) throw new Error("Fixture refresh failed");
      return response.json();
    },
    onResult: () => {},
  });
  return (
    <main className="mx-auto min-w-0 max-w-5xl space-y-5 p-4">
      <label className="block text-xs">
        测试状态{" "}
        <select
          data-testid="fixture-case"
          value={mode}
          onChange={(event) => setMode(event.target.value)}
        >
          <option value="prepared">prepared</option>
          <option value="submitted">submitted</option>
          <option value="empty">空态</option>
        </select>
      </label>
      <p data-testid="polling-state" className="text-xs">
        {state}
      </p>
      <section data-testid="perspective-project" className="min-w-0">
        <ProjectContextFacts
          info={
            empty
              ? {
                  ...projectFixture,
                  agents: { ...projectFixture.agents, agents: [] },
                  machines: [],
                  chats: [],
                  leases: { available: true, items: [] },
                }
              : projectFixture
          }
        />
      </section>
      <section
        data-testid="perspective-chat"
        className="min-w-0 space-y-3 border-t border-border pt-4"
      >
        <h2 className="text-sm font-medium">Chat</h2>
        <ChatFactsBlock
          view={empty ? { ...chatFixture, members: [], instances: [] } : chatFixture}
        />
        <RunFactsBlock runs={chatFixture.runs} testId="info-chat-runs" />
      </section>
      <section data-testid="perspective-agent" className="min-w-0 border-t border-border pt-4">
        <AgentInfoPanel view={empty ? { ...agentFixture, instances: [] } : agentFixture} />
      </section>
      <section
        data-testid="perspective-machine"
        className="min-w-0 space-y-3 border-t border-border pt-4"
      >
        <h2 className="text-sm font-medium">Machine</h2>
        <AgentStatusFact status={agentFixture.agent.status} error={agentFixture.agent.error} />
        <RunFactsBlock runs={agentFixture.runs} testId="info-machine-runs" />
        {empty ? (
          <p data-testid="info-machines-empty" className="text-xs">
            本 Project 没有关联的 Machine，无 Machine 租约。
          </p>
        ) : (
          <MachineSummaryFact machine={machineFixture} />
        )}
      </section>
      <TurnStartContextBlock
        context={
          empty
            ? null
            : mode === "submitted"
              ? {
                  ...contextFixture,
                  deliveryState: "submitted",
                  submittedAt: contextFixture.capturedAt,
                  injectedIntoPrompt: true,
                }
              : contextFixture
        }
      />
    </main>
  );
}
const rootRoute = createRootRoute({ component: Outlet });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Page });
const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
