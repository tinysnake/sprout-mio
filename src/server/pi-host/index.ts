import { Effect } from "effect";
import { interruptActiveAgentRuns, queuedRunWork } from "../../domain/agent-run";
import { makePiHostLayer } from "./host";
import { PiSessionProcess } from "./process";
import { executeRun } from "./run";
import type { Work } from "./run";

type HostWork = Work & { readonly instanceId: string };

export const piHostLayer = makePiHostLayer<HostWork>({
  loadWork: () => queuedRunWork().map((work) => ({ ...work, instanceId: work.run.instanceId })),
  interruptActiveRuns: () => interruptActiveAgentRuns(),
  prepareRun: (work, signals) => {
    const process = new PiSessionProcess(work.run.id);
    return {
      runId: work.run.id,
      pid: process.pid,
      abort: () => process.abortSession(),
      close: () => process.close(),
      body: executeRun(work, process, signals).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => console.error("[pi-host] Run 状态保存失败", cause)),
        ),
      ),
    };
  },
});
