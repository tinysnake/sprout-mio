import { useState } from "react";
import { createRoot } from "react-dom/client";
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
  const path = window.location.pathname;
  const kind = path.endsWith("/wake")
    ? "wake"
    : path.endsWith("/continuation")
      ? "continuation"
      : null;
  const evaluationId = path.split("/").at(-2) ?? "";
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
createRoot(document.getElementById("root")!).render(<FixturePage />);
