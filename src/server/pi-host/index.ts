import { Cause, Effect } from "effect";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { interruptActiveAgentRuns, queuedRunWork } from "../../domain/agent-run";
import { recordDiagnostic } from "../diagnostics";
import { makePiHostLayer } from "./host";
import { PiSessionProcess } from "./process";
import { executeRun } from "./run";
import type { PiHostDeps } from "./host";
import type { Work } from "./run";

type HostWork = Work & { readonly instanceId: string };

// 宿主级失败不属于任何请求，用新生成的关联码归入诊断组，
// 与 src/server/runtime.ts 记录 runtime.ready 的做法一致。
const reportFailure: PiHostDeps<HostWork>["reportFailure"] = (failure) => {
  recordDiagnostic({
    level: "error",
    event: failure.event,
    requestId: newId(ID_PREFIXES.request),
    message: failure.message,
    data: { cause: Cause.pretty(failure.cause) },
  });
};

export const piHostLayer = makePiHostLayer<HostWork>({
  loadWork: () => queuedRunWork().map((work) => ({ ...work, instanceId: work.run.instanceId })),
  interruptActiveRuns: () => interruptActiveAgentRuns(),
  reportFailure,
  prepareRun: (work, signals) => {
    const process = new PiSessionProcess(work.run.id);
    return {
      runId: work.run.id,
      pid: process.pid,
      abort: () => process.abortSession(),
      close: () => process.close(),
      body: executeRun(work, process, signals).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            reportFailure({
              event: "pi_host.run_persist_failed",
              message: "Run 状态保存失败",
              cause,
            }),
          ),
        ),
      ),
    };
  },
});
