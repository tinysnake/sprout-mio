import { useEffect, useState } from "react";
import type { AppError } from "../../contracts/result";
import { getMachineActivityFn } from "../../server/functions/machine";

/** 机器页的活性来源：只读一个小 revision，事实真的变了才让整页重取。 */
export const MACHINE_ACTIVITY_POLL_MS = 3000;

type Environment = {
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  window: Pick<Window, "setTimeout" | "clearTimeout">;
};

/**
 * 机器范围的 revision 读取调度。
 *
 * 与 `createInfoHubPolling` 同一副骨架（隐藏时不读、单次在途、重新可见立刻补读），
 * 但这里不需要退避与 abort：一次读取只有一个 64 位 hex 字段，失败就保留上一次
 * 结论、下一轮再读，不在页面上另造一个「离线」状态。
 */
export function createMachineActivityPolling({
  read,
  intervalMs,
  environment,
  onRevision,
  onError,
}: {
  read: () => Promise<string>;
  intervalMs: number;
  environment: Environment;
  /** 只有读到的 revision 与上一次不同才上报；首次读到也算变化。 */
  onRevision: (revision: string, previous: string | null) => void;
  onError?: (error: AppError | null) => void;
}) {
  const { document, window } = environment;
  let timer: number | undefined;
  let inFlight = false;
  let stopped = false;
  let resumePending = false;
  let revision: string | null = null;
  const clearTimer = () => {
    window.clearTimeout(timer);
    timer = undefined;
  };
  const visible = () => document.visibilityState === "visible";

  function schedule() {
    clearTimer();
    if (stopped || !visible()) return;
    timer = window.setTimeout(() => void request(), intervalMs);
  }

  async function request() {
    clearTimer();
    // 隐藏期间不读，也不为隐藏期间的失败补发。
    if (stopped || inFlight || !visible()) return;
    inFlight = true;
    try {
      const next = await read();
      if (stopped) return;
      if (next !== revision) {
        const previous = revision;
        revision = next;
        onRevision(next, previous);
      }
      onError?.(null);
    } catch (error) {
      if (!stopped) onError?.(asAppError(error));
    } finally {
      inFlight = false;
      if (stopped) return;
      if (resumePending) {
        resumePending = false;
        void request();
      } else schedule();
    }
  }

  function resume() {
    clearTimer();
    if (!visible()) return;
    // 隐藏在途请求不并发的第二条：等在途结束后立刻补读。
    if (inFlight) resumePending = true;
    else void request();
  }

  document.addEventListener("visibilitychange", resume);
  void request();
  return () => {
    stopped = true;
    clearTimer();
    document.removeEventListener("visibilitychange", resume);
  };
}

function asAppError(cause: unknown): AppError {
  if (cause && typeof cause === "object" && "code" in cause && "message" in cause)
    return cause as AppError;
  return {
    code: "internal",
    message: "活动状态读取失败，当前显示可能已过期。",
    requestId: "unavailable",
  };
}

export type MachineActivityState = {
  /** 第一次成功读到之前是 null；null 与「读到 revision」是两种不同状态。 */
  revision: string | null;
  error: AppError | null;
};

/**
 * 页面只需要「变没变」。读失败保留上一次 revision 并露出错误，
 * 由页面已有的「当前状态未确认」呈现，不在这里另造连接状态。
 */
export function useMachineActivity({
  machineId,
  projectId,
}: {
  machineId: string;
  projectId?: string;
}): MachineActivityState {
  const [revision, setRevision] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  useEffect(() => {
    setRevision(null);
    setError(null);
    return createMachineActivityPolling({
      intervalMs: MACHINE_ACTIVITY_POLL_MS,
      environment: { document, window },
      read: async () => {
        const result = await getMachineActivityFn({
          data: { machineId, ...(projectId ? { projectId } : {}) },
        });
        if (!result.ok) throw result.error;
        return result.data;
      },
      onRevision: (next) => setRevision(next),
      onError: setError,
    });
  }, [machineId, projectId]);

  return { revision, error };
}
