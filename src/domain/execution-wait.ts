import { isTerminalExecutionState, type ExecutionView } from "../contracts/remote";
import { EXECUTION_WAIT_POLL_MS } from "../contracts/tool-wait";

export interface WaitForExecutionDeps {
  readonly readExecution: () => ExecutionView | Promise<ExecutionView>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
}

/**
 * 轮询同一个 execution 到终态，或到绝对截止时刻 `deadlineMs`。
 * 预算从工具调用开始计时，由调用方在提交前算好 `deadlineMs`；本函数不再夹取预算。
 * 提交/首次读取拿到的 `firstView` 直接当作第一次读，不额外发一次 `execution_get`。
 */
export async function waitForExecution(input: {
  deadlineMs: number;
  firstView?: ExecutionView;
  pollMs?: number;
  deps: WaitForExecutionDeps;
}): Promise<
  { ok: true; view: ExecutionView } | { ok: false; reason: "timed_out"; view: ExecutionView }
> {
  const { deps } = input;
  const pollMs = input.pollMs ?? EXECUTION_WAIT_POLL_MS;
  let view: ExecutionView | undefined = input.firstView;
  for (;;) {
    if (!view) view = await deps.readExecution();
    if (isTerminalExecutionState(view.state)) return { ok: true, view };
    const remaining = input.deadlineMs - deps.now().getTime();
    if (remaining <= 0) return { ok: false, reason: "timed_out", view };
    await deps.sleep(Math.min(pollMs, remaining));
    view = undefined;
  }
}
