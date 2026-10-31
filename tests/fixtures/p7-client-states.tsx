import { createRoot } from "react-dom/client";
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { ChatPane } from "../../src/components/chat/chat-pane";
import { LeaseMutationForm } from "../../src/components/machine/lease-panel";
import { ConnectivityStatus } from "../../src/components/layout/connectivity-status";
import { request } from "./p7-client-actions";
const projectId = "prj_00000000-0000-4000-8000-000000000001";
const chatId = "cnv_00000000-0000-4000-8000-000000000002";
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
const runState: any = ok({
  enabled: true,
  runs: [
    {
      id: "run_p7",
      projectId,
      chatId,
      instanceId: "instance",
      status: "running",
      startedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      configSnapshot: {},
    },
  ],
  inputs: [],
});
const info: any = ok({ members: [], runs: { active: [], recent: [] } });
function Scene() {
  return (
    <div className="flex h-dvh flex-col">
      <ConnectivityStatus />
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatPane
          projectId={projectId}
          session={session}
          profile={null}
          humanName="Human"
          messages={ok([])}
          info={info}
          runState={runState}
          inspectorOpen={false}
          onToggleInspector={() => {}}
          onChanged={() => {}}
        />
      </div>
      <div className="shrink-0 p-4">
        <LeaseMutationForm
          projectId={projectId}
          machines={[]}
          leases={[]}
          fixedTargetId="mch_p7"
          submit={request}
          testId="p7-lease"
        />
      </div>
    </div>
  );
}
const rootRoute = createRootRoute({ component: Scene });
const router = createRouter({ routeTree: rootRoute });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
