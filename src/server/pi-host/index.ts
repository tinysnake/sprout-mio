import { Effect } from "effect";
import { interruptActiveAgentRuns, queuedRunWork } from "../../domain/agent-run";
import { config } from "../../lib/config";
import { PiSessionProcess } from "./process";
import { executeRun } from "./run";
import type { Work } from "./run";

type HostState = {
  timer?: ReturnType<typeof setInterval>;
  stopping: boolean;
  started: boolean;
  active: Map<string, { process: PiSessionProcess; task: Promise<void> }>;
  shutdown?: Promise<void>;
};
const scope = globalThis as typeof globalThis & { sproutPiHost?: HostState };
const host: HostState = (scope.sproutPiHost ??= {
  stopping: false,
  started: false,
  active: new Map(),
});

function execute(work: Work, process: PiSessionProcess): Promise<void> {
  return Effect.runPromise(executeRun(work, process, { isStopping: () => host.stopping })).catch(
    (error) => {
      console.error("[pi-host] Run 状态保存失败", error);
    },
  );
}

function dispatch(): void {
  if (host.stopping) return;
  try {
    for (const work of queuedRunWork()) {
      if (host.active.has(work.run.instanceId)) continue;
      const process = new PiSessionProcess(work.run.id);
      const task = execute(work, process).finally(() => {
        host.active.delete(work.run.instanceId);
      });
      host.active.set(work.run.instanceId, { process, task });
    }
  } catch (error) {
    console.error("[pi-host] 调度失败", error);
  }
}

export function startPiHost(): void {
  if (host.started) return;
  host.started = true;
  if (!config.SPROUT_PI_ENABLED) return;
  host.timer = setInterval(dispatch, 100);
  host.timer.unref();
}

export function piHostSnapshot() {
  return {
    enabled: config.SPROUT_PI_ENABLED,
    stopping: host.stopping,
    active: [...host.active].map(([instanceId, entry]) => ({ instanceId, pid: entry.process.pid })),
  };
}

/** 停止的真值在 run 状态机；这里只把已定格的停止传导给活着的子进程。 */
export function signalRunAbort(runId: string): boolean {
  for (const { process } of host.active.values()) {
    if (process.id === runId) {
      process.abortSession();
      return true;
    }
  }
  return false;
}

export function stopPiHost(): Promise<void> {
  return (host.shutdown ??= (async () => {
    host.stopping = true;
    clearInterval(host.timer);
    let recoveryError: unknown;
    try {
      interruptActiveAgentRuns();
    } catch (error) {
      recoveryError = error;
    }
    const entries = [...host.active.values()];
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(
          entries.map(async ({ process, task }) => {
            await process.close();
            await task;
          }),
        ).then((results) => {
          const failed = results.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        }),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error("Pi 关闭超时 (2500ms)")), 2500);
        }),
      ]);
      if (recoveryError) throw recoveryError;
    } finally {
      clearTimeout(deadline);
    }
  })());
}
