import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AutomationPanel } from "../../src/components/automation/automation-panel";
import { WakeProviderSelect } from "../../src/components/automation/wake-provider-select";
import { automationFixture, automationDenials, p6aCases } from "./p6a-pages";
import type { P6aCase } from "./p6a-pages";
import type { AutomationSubmit } from "../../src/components/automation/automation-page-data";

function Scenario({ name }: { name: P6aCase }) {
  const [view, setView] = useState(() => automationFixture(name));
  const [lastCommand, setLastCommand] = useState("");
  const [failWrite, setFailWrite] = useState(false);
  const onCommand: AutomationSubmit = async (command) => {
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
    // Explicit UI responses only. This fixture does not implement scheduler policy or delivery.
    const next =
      command.action === "disable"
        ? automationFixture("off")
        : command.action === "abort"
          ? automationFixture("off")
          : command.action === "enable"
            ? automationFixture("scheduled")
            : view;
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
    return { ok: true, data: { view: next, denials: automationDenials(name) } };
  };
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
      <AutomationPanel data={{ view, denials: automationDenials(name) }} onCommand={onCommand} />
      <output data-testid="last-command" className="mt-4 block text-xs break-all">
        {lastCommand}
      </output>
      <WakeProviderSelect />
    </>
  );
}
function FixturePage() {
  const [name, setName] = useState<P6aCase>("idle");
  return (
    <main className="mx-auto w-full max-w-3xl space-y-4 p-4">
      <h1 className="text-lg">自动接续 · 组件契约验收</h1>
      <p className="text-xs text-muted-foreground">
        此处使用冻结契约 fixture；实际产品读取服务尚未接入。
      </p>
      <label className="flex flex-col gap-2 text-xs">
        验收状态
        <select
          data-testid="fixture-case"
          className="h-9 w-full rounded-control border border-input bg-background px-3"
          value={name}
          onChange={(event) => setName(event.target.value as P6aCase)}
        >
          {p6aCases.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <Scenario key={name} name={name} />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<FixturePage />);
