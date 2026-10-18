import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AgentRunError,
  completeAgentRun,
  firstPendingRunInput,
  getAgentRun,
  interruptActiveAgentRuns,
  markRunInputDelivered,
  pendingRunInputs,
  previousSessionFile,
  queuedRunWork,
  recordRunInputDeliveryFailure,
  transitionAgentRun,
} from "../../domain/agent-run";
import type { ProjectContext } from "../../domain/access";
import { config } from "../../lib/config";
import { PiHostFailure, piInstancePaths, PiSessionProcess } from "./process";

type Work = ReturnType<typeof queuedRunWork>[number];
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

async function execute(work: Work, process: PiSessionProcess): Promise<void> {
  const { run, profile } = work;
  const ctx: ProjectContext = { userId: work.ownerId, requestId: run.requestId };
  const sent = new Set<string>();
  try {
    const input = firstPendingRunInput(run.id, ctx);
    if (!input) throw new PiHostFailure("input_missing", "Run 缺少输入消息");
    const paths = piInstancePaths(run.instanceId);
    const snapshot = await process.open({
      type: "open",
      id: run.id,
      instanceId: run.instanceId,
      sessionId: run.sessionId,
      sessionFile: previousSessionFile(run.id, ctx),
      ...paths,
      agentDir: resolve(
        globalThis.process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
      ),
      extensionPath: resolve("pi/sprout-extension.ts"),
      profile: {
        id: profile.id,
        name: profile.name,
        persona: profile.persona,
        harness: profile.harness,
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.effort ? { effort: profile.effort } : {}),
        updatedAt: profile.updatedAt.toISOString(),
      },
    });
    if (host.stopping) return;
    transitionAgentRun(run.id, "running", { configSnapshot: snapshot }, ctx);
    process.onDelivered = (messageId) => {
      if (host.stopping) return;
      try {
        markRunInputDelivered(run.id, messageId, ctx);
      } catch (error) {
        // 用户停止后迟到的投递确认保持 pending，不升级成进程故障。
        if (!(error instanceof AgentRunError && error.code === "conflict")) throw error;
      }
    };
    process.onRejected = (messageId, reason) => {
      if (!host.stopping) recordRunInputDeliveryFailure(run.id, messageId, reason, ctx);
    };
    sent.add(input.message.id);
    const promptTask = process.prompt(input.message.id, input.message.body);
    const delivery = setInterval(() => {
      try {
        if (host.stopping) return;
        for (const pending of pendingRunInputs(run.id, ctx)) {
          if (sent.has(pending.messageId)) continue;
          sent.add(pending.messageId);
          try {
            process.steer(pending.messageId, pending.text);
          } catch {
            recordRunInputDeliveryFailure(
              run.id,
              pending.messageId,
              "Pi runner 通信失败，消息未投递",
              ctx,
            );
            clearInterval(delivery);
            return;
          }
        }
      } catch {
        // 投递轮询失败不拉倒宿主；run 级故障由 prompt 路径报告。
        clearInterval(delivery);
      }
    }, 100);
    delivery.unref();
    let result: Awaited<ReturnType<typeof process.prompt>>;
    try {
      result = await promptTask;
    } finally {
      clearInterval(delivery);
    }
    await process.close();
    if (!host.stopping) completeAgentRun(run.id, result.text, result.stopReason, ctx);
  } catch (error) {
    if (!host.stopping) {
      const current = getAgentRun(run.id, ctx);
      if (current.status === "queued" || current.status === "running") {
        const failure =
          error instanceof PiHostFailure
            ? error
            : new PiHostFailure("run_failed", "Agent run 执行失败");
        transitionAgentRun(
          run.id,
          "failed",
          {
            errorCode: failure.code,
            errorMessage: failure.message,
            stopReason: failure.stopReason,
          },
          ctx,
        );
      }
    }
  } finally {
    await process.close().catch(() => {});
  }
}

function dispatch(): void {
  if (host.stopping) return;
  try {
    for (const work of queuedRunWork()) {
      if (host.active.has(work.run.instanceId)) continue;
      const process = new PiSessionProcess(work.run.id);
      const task = execute(work, process)
        .catch((error) => {
          console.error("[pi-host] Run 状态保存失败", error);
        })
        .finally(() => {
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
