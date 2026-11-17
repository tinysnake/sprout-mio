import { createRoot } from "react-dom/client";
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { ChatPane } from "../../src/components/chat/chat-pane";
import { ConnectivityStatus } from "../../src/components/layout/connectivity-status";
const projectId = "prj_00000001";
const chatId = "cnv_00000002";
const ok = (data: any) => ({ ok: true as const, data, requestId: "req_p7" });
const session: any = {
  kind: "group",
  instances: [],
  governance: { canRenameTitle: false },
  chat: {
    id: chatId,
    projectId,
    kind: "group",
    title: "P7 Actions",
    createdBy: "human",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archivedAt: null,
  },
};
const activeRun = {
  id: "run_p7",
  projectId,
  chatId,
  instanceId: "instance",
  status: "running",
  queuedAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  sessionId: "session_p7",
};
const runState: any = ok({
  enabled: true,
  active: [{ id: activeRun.id, status: activeRun.status }],
  latest: activeRun,
  inputs: [],
});
const info: any = ok({ members: [], runs: { active: [], recent: [] } });
function Scene() {
  return (
    <div className="flex h-dvh flex-col">
      <ConnectivityStatus />
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatPane
          skills={{ state: "unavailable", items: [] }}
          projectId={projectId}
          session={session}
          profile={null}
          humanName="Human"
          page={ok({
            messages: [],
            tailCursor: null,
            olderCursor: null,
            hasOlder: false,
            hasNewer: false,
          })}
          live={null}
          info={info}
          runState={runState}
          runActivities={ok([])}
          inspectorOpen={false}
          onToggleInspector={() => {}}
          onChanged={() => {}}
        />
      </div>
    </div>
  );
}
const rootRoute = createRootRoute({ component: Scene });
const router = createRouter({ routeTree: rootRoute });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
