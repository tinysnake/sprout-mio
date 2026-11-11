import { isTerminalExecutionState, type ExecutionView } from "../contracts/remote";
import { clampExecutionWaitMs, EXECUTION_WAIT_POLL_MS } from "../contracts/tool-wait";

export interface WaitForExecutionDeps {
  readonly readExecution: () => ExecutionView | Promise<ExecutionView>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
}

export async function waitForExecution(input: {
  requestedMs?: number;
  pollMs?: number;
  deps: WaitForExecutionDeps;
}): Promise<
  { ok: true; view: ExecutionView } | { ok: false; reason: "timed_out"; view: ExecutionView }
> {
  const { deps } = input;
  const deadline = deps.now().getTime() + clampExecutionWaitMs(input.requestedMs);
  const pollMs = input.pollMs ?? EXECUTION_WAIT_POLL_MS;
  for (;;) {
    const view = await deps.readExecution();
    if (isTerminalExecutionState(view.state)) return { ok: true, view };
    const remaining = deadline - deps.now().getTime();
    if (remaining <= 0) return { ok: false, reason: "timed_out", view };
    await deps.sleep(Math.min(pollMs, remaining));
  }
}
