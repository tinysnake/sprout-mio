import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import { chatContinuationViewSchema } from "../../src/contracts/chat-continuation";
import { ContinuationPanel } from "../../src/components/continuation/continuation-panel";
import { ContinuationDiagnostic } from "../../src/components/continuation/continuation-diagnostic";
import { WakeProviderSelect } from "../../src/components/continuation/wake-provider-select";
import { diagnosticFixture, continuationDenials, p6aCases } from "./p6a-pages";
import type { P6aCase } from "./p6a-pages";
import type { ContinuationSubmit } from "../../src/components/continuation/continuation-page-data";

function Scenario({ name }: { name: P6aCase }) {
  const [view, setView] = useState(() => chatContinuationViewSchema.parse(diagnosticFixture(name)));
  const [lastCommand, setLastCommand] = useState("");
  const [failWrite, setFailWrite] = useState(false);
  const onCommand: ContinuationSubmit = async (command) => {
    setLastCommand(JSON.stringify(command));
    if (failWrite)
      return {
        ok: false,
        error: {
          code: "conflict",
          reason: "读取已过期，请刷新事实后再操作",
          requestId: "fixture-request",
        },
      };
    // Explicit UI responses, never scheduler or delivery policy.
    const next =
      command.action === "disable" || (command.action === "abort" && !command.runId)
        ? diagnosticFixture("off")
        : command.action === "enable"
          ? diagnosticFixture("scheduled")
          : view;
    next.latestEvaluation = view.latestEvaluation;
    next.recentRounds = view.recentRounds;
    next.activeRunIds =
      command.action === "abort" && command.runId
        ? view.activeRunIds.filter((id) => id !== command.runId)
        : command.action === "abort"
          ? []
          : view.activeRunIds;
    next.deliveries = view.deliveries;
    next.owner = view.owner;
    next.remindedHuman = view.remindedHuman;
    setView(next);
    return { ok: true, data: { view: next, denials: continuationDenials(name) } };
  };
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const kind = pathname.endsWith("/wake")
    ? "wake"
    : pathname.endsWith("/continuation")
      ? "continuation"
      : null;
  const evaluationId = pathname.split("/").at(-2) ?? "";
  return (
    <>
      <p className="mb-4 text-xs">Task 状态：已分配</p>
      <label className="mb-4 flex gap-2 text-xs">
        <input
          type="checkbox"
          checked={failWrite}
          onChange={(event) => setFailWrite(event.target.checked)}
        />
        模拟写入冲突
      </label>
      {kind ? (
        <div className="flex min-h-[700px] flex-col border border-border">
          <ContinuationDiagnostic
            key={evaluationId}
            data={{ view, denials: continuationDenials(name) }}
            evaluationId={evaluationId}
            kind={kind}
            chatTitle="三木 · 项目上下文核对"
            onCommand={onCommand}
          />
        </div>
      ) : (
        <div className="max-w-sm">
          <ContinuationPanel data={{ view, denials: continuationDenials(name) }} />
        </div>
      )}
      <output data-testid="last-command" className="mt-4 block text-xs break-all">
        {lastCommand}
      </output>
      <WakeProviderSelect />
    </>
  );
}
function FixturePage() {
  const [name, setName] = useState<P6aCase>(() => {
    const saved = sessionStorage.getItem("p6b-case");
    return p6aCases.find((item) => item === saved) ?? "idle";
  });
  return (
    <div className="w-full space-y-4 p-4">
      <h1 className="text-lg">对话自动化 · 共享页面契约验收</h1>
      <p className="text-xs text-muted-foreground">
        此处为显式契约 fixture 与模拟写入响应；正式页面读取既有服务。
      </p>
      <label className="flex flex-col gap-2 text-xs">
        验收状态
        <select
          data-testid="fixture-case"
          className="h-9 w-full rounded-control border border-input bg-background px-3"
          value={name}
          onChange={(event) => {
            const value = event.target.value as P6aCase;
            sessionStorage.setItem("p6b-case", value);
            setName(value);
          }}
        >
          {p6aCases.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <Scenario key={name} name={name} />
    </div>
  );
}
// 页面内的入口与轮次链接走 TanStack Router 客户端导航，fixture 也要有真实路由表，
// 否则 Link 没有 router 上下文，点击也无法在 fixture 内换页。
const rootRoute = createRootRoute();
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: FixturePage,
});
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/chats/$chatId",
  component: FixturePage,
});
const wakeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/chats/$chatId/checks/$evaluationId/wake",
  component: FixturePage,
});
const continuationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/chats/$chatId/checks/$evaluationId/continuation",
  component: FixturePage,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, chatRoute, wakeRoute, continuationRoute]),
});
await router.load();
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
