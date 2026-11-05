import { useCallback, useEffect, useRef, useState } from "react";
import type { AppError } from "../../contracts/result";
import {
  machineRelationsFn,
  projectMachineRelationsFn,
  type MachineRelationView,
} from "../../server/functions/membership";

const REFRESH_MS = 5000;
// 一次读取的上限。revision 模式没有定时器，读取失败或一直不落地时页面就停在
// 「未确认」了；所以每次读取都挂上限，超时就放弃这次读取并重读。
const READ_DEADLINE_MS = 5000;

const UNCONFIRMED: AppError = {
  code: "internal",
  message: "关系事实读取失败，当前状态未确认。",
  requestId: "unavailable",
};

type ScheduleEnvironment = {
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  window: Pick<Window, "setInterval" | "clearInterval">;
};

/**
 * 关系事实的读取调度。
 *
 * 给了 revision 就不需要定时器：Hub 的 revision 变了才说明这批事实可能变了，
 * 页面按 revision 读，省掉一次整页扫描。没有 revision 来源时退回定时读
 * （Machine 详情页只有一个 Machine，没有对应的 Hub 视角）。
 */
export function createRelationReads({
  read,
  intervalMs,
  environment,
}: {
  read: () => void;
  intervalMs: number;
  environment: ScheduleEnvironment;
}) {
  const { document, window } = environment;
  let revision: string | null | undefined;
  let started = false;
  let timer: number | undefined;
  const stopTimer = () => {
    window.clearInterval(timer);
    timer = undefined;
  };
  // 隐藏期间的读都是白跑：定时分支按时钟醒来也不发请求。
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") read();
  };

  function startInterval() {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    stopTimer();
    read();
    timer = window.setInterval(() => {
      if (document.visibilityState === "visible") read();
    }, intervalMs);
  }

  function startRevision() {
    stopTimer();
    // 隐藏期间 revision 可能没变，但事实已经变了；重新可见时补读一次。
    document.addEventListener("visibilitychange", onVisibilityChange);
    read();
  }

  return {
    /** 建立调度；之后只有 revision 真的变化才重读，`undefined` 表示没有 revision 来源。 */
    sync(next: string | null | undefined) {
      if (!started) {
        started = true;
        revision = next;
        if (next === undefined) startInterval();
        else startRevision();
        return;
      }
      if (next === revision) return;
      const wasInterval = revision === undefined;
      revision = next;
      if (next === undefined) {
        if (!wasInterval) startInterval();
      } else if (wasInterval) {
        startRevision();
      } else {
        read();
      }
    },
    refresh: read,
    stop() {
      started = false;
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}

export type MachineRelationsState = {
  relations: MachineRelationView[];
  loading: boolean;
  /** 最近一次成功读到服务端事实的时间；null 表示本次打开页面还没成功过。 */
  lastSuccessAt: string | null;
  /** 最近一次刷新失败；保留 `relations`，页面必须标「当前状态未确认」。 */
  error: AppError | null;
  refresh: () => void;
};

/**
 * 关系统一读取：Project 范围与 Machine 范围各走一个 Human 边界。
 * 失败时保留上次成功事实并留下错误，不把旧快照当当前状态。
 * 传 `revision` 的页面按 revision 变化读；不传的页面（Machine 详情）沿用五秒刷新。
 * 两种模式下读取都不许跨过五秒没结果：超时放弃并重读，页面最多落后一次读取窗口。
 */
export function useMachineRelations({
  projectId,
  machineId,
  revision,
}: {
  projectId?: string;
  machineId?: string;
  revision?: string | null;
}): MachineRelationsState {
  const [relations, setRelations] = useState<MachineRelationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastSuccessAt, setLastSuccessAt] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const reading = useRef(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const deadline = useRef<number | undefined>(undefined);
  const disposed = useRef(false);
  const schedule = useRef<ReturnType<typeof createRelationReads> | null>(null);
  const latestRevision = useRef(revision);
  latestRevision.current = revision;

  const load = useCallback(async () => {
    if (reading.current) {
      // 在途读取期间来的触发不能丢：读完之后补一次，否则页面会停在「未确认」。
      pending.current = true;
      return;
    }
    reading.current = true;
    const gen = (generation.current += 1);
    const dropDeadline = () => {
      window.clearTimeout(deadline.current);
      deadline.current = undefined;
    };
    const expire = () => {
      deadline.current = undefined;
      if (disposed.current) return;
      if (reading.current && generation.current === gen) {
        reading.current = false;
        setError(UNCONFIRMED);
        setLoading(false);
      }
      if (document.visibilityState === "visible") void load();
    };
    const armDeadline = () => {
      dropDeadline();
      deadline.current = window.setTimeout(expire, READ_DEADLINE_MS);
    };
    armDeadline();
    try {
      const result = projectId
        ? await projectMachineRelationsFn({ data: { projectId } })
        : machineId
          ? await machineRelationsFn({ data: { machineId } })
          : null;
      if (disposed.current || generation.current !== gen) return;
      if (!result) {
        setRelations([]);
        setLastSuccessAt(new Date().toISOString());
        setError(null);
        dropDeadline();
        return;
      }
      if (!result.ok) {
        setError(result.error);
        if (document.visibilityState === "visible") armDeadline();
        return;
      }
      setRelations(result.data);
      setLastSuccessAt(new Date().toISOString());
      setError(null);
      dropDeadline();
    } catch {
      if (disposed.current || generation.current !== gen) return;
      setError(UNCONFIRMED);
      if (document.visibilityState === "visible") armDeadline();
    } finally {
      // 这次读取已经被放弃：定时器和读取状态都归新的那次。
      if (generation.current !== gen) return;
      dropDeadline();
      reading.current = false;
      if (!disposed.current) setLoading(false);
      if (pending.current && !disposed.current) {
        pending.current = false;
        void load();
      }
    }
  }, [projectId, machineId]);

  useEffect(() => {
    disposed.current = false;
    reading.current = false;
    pending.current = false;
    window.clearTimeout(deadline.current);
    deadline.current = undefined;
    setLoading(true);
    setError(null);
    const reads = createRelationReads({
      read: () => void load(),
      intervalMs: REFRESH_MS,
      environment: { document, window },
    });
    schedule.current = reads;
    reads.sync(latestRevision.current);
    return () => {
      disposed.current = true;
      reads.stop();
      schedule.current = null;
      window.clearTimeout(deadline.current);
      deadline.current = undefined;
    };
  }, [load]);

  // revision 变化只补读事实，不重置 loading：每轮刷新都翻一次加载态会让页面闪。
  useEffect(() => {
    schedule.current?.sync(revision);
  }, [revision]);

  return {
    relations,
    loading,
    lastSuccessAt,
    error,
    refresh: () => void load(),
  };
}
