import { isTerminalExecutionState, type ExecutionView } from "../../src/contracts/remote";

export function executionWaitView(state: ExecutionView["state"] = "running"): ExecutionView {
  const terminal = isTerminalExecutionState(state);
  return {
    projectId: "prj_00000000",
    machineId: "mch_00000000",
    executionId: "exe_00000000",
    requestId: "req_00000000",
    authorizationGeneration: 1,
    holderInstanceId: "ins_00000000",
    authority: "holder",
    currentAuthorizationGeneration: 1,
    runId: "run_00000000",
    chatId: "cnv_00000000",
    operation: { kind: "shell", command: "true", waitMs: 0 },
    state,
    createdAt: "2026-10-24T00:00:00.000Z",
    dispatchDeadlineAt: "2026-10-24T00:01:00.000Z",
    runtimeDeadlineAt: null,
    maxRuntimeMs: null,
    dispatchConnectionGeneration: null,
    dispatchSeq: null,
    dispatchedAt: null,
    drainedAt: null,
    payloadHash: "a".repeat(64),
    terminalAt: terminal ? "2026-10-24T00:01:00.000Z" : null,
    failureReason: terminal && state !== "succeeded" ? "deadline" : null,
    recoveryReason: null,
    result: null,
    logState: "none",
    producedThroughSequence: null,
    acknowledgedThroughSequence: null,
    availableFromSequence: null,
    cancellation: null,
  };
}
