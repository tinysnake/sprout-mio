import { useState } from "react";
import type { ConversationRunState } from "../../contracts/agent-run";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { abortAgentRunFn } from "../../server/functions/agent-run";
import { Button } from "../ui/button";
import { ResultError } from "../project/result-error";

const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  aborted: "已停止",
  interrupted: "已中断",
};

/** run 状态与输入投递状态都来自领域查询；pending 输入永远显示为未投递，不冒充已处理。 */
export function RunStatusPanel({
  state,
  onAbort,
}: {
  state: ConversationRunState;
  onAbort: () => void;
}) {
  const [aborting, setAborting] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const run = state.runs.at(-1);
  const pending = state.inputs.filter((input) => input.disposition === "pending").length;
  const status = !state.enabled
    ? "宿主未启用"
    : run
      ? (STATUS_LABELS[run.status] ?? run.status)
      : "尚未运行";
  const active = run?.status === "queued" || run?.status === "running";

  async function stop() {
    if (!run || aborting) return;
    setAborting(true);
    setError(null);
    try {
      const result = await abortAgentRunFn({ data: { runId: run.id } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onAbort();
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setAborting(false);
    }
  }

  return (
    <section className="space-y-2 rounded-lg border p-4 text-sm">
      <p>
        <span className="text-muted-foreground">分身运行状态：</span>
        <span data-testid="pi-host-status">{status}</span>
      </p>
      {pending > 0 && <p data-testid="pending-input-count">{pending} 条输入未投递</p>}
      {run?.status === "failed" && (
        <>
          <p data-testid="run-failure">{run.errorMessage ?? "未知失败原因"}</p>
          <p data-testid="run-failure-request" className="font-mono text-xs">
            requestId: {run.requestId}
          </p>
        </>
      )}
      {active && (
        <Button data-testid="run-stop" onClick={() => void stop()} disabled={aborting}>
          {aborting ? "正在停止…" : "停止本轮"}
        </Button>
      )}
      {error && <ResultError error={error} testId="run-stop-error" />}
    </section>
  );
}
