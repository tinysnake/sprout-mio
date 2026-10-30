import { useCallback, useEffect, useRef, useState } from "react";
import type { AppError } from "../../contracts/result";
import {
  machineRelationsFn,
  projectMachineRelationsFn,
  type MachineRelationView,
} from "../../server/functions/membership";

const REFRESH_MS = 5000;

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
 * 五秒刷新沿用既有策略；失败时保留上次成功事实并留下错误，不把旧快照当当前状态。
 */
export function useMachineRelations({
  projectId,
  machineId,
}: {
  projectId?: string;
  machineId?: string;
}): MachineRelationsState {
  const [relations, setRelations] = useState<MachineRelationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastSuccessAt, setLastSuccessAt] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const reading = useRef(false);
  const disposed = useRef(false);

  const load = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const result = projectId
        ? await projectMachineRelationsFn({ data: { projectId } })
        : machineId
          ? await machineRelationsFn({ data: { machineId } })
          : null;
      if (disposed.current) return;
      if (!result) {
        setRelations([]);
        setLastSuccessAt(new Date().toISOString());
        setError(null);
        return;
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRelations(result.data);
      setLastSuccessAt(new Date().toISOString());
      setError(null);
    } catch {
      if (disposed.current) return;
      setError({
        code: "internal",
        message: "关系事实读取失败，当前状态未确认。",
        requestId: "unavailable",
      });
    } finally {
      reading.current = false;
      if (!disposed.current) setLoading(false);
    }
  }, [projectId, machineId]);

  useEffect(() => {
    disposed.current = false;
    reading.current = false;
    setLoading(true);
    setError(null);
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => {
      disposed.current = true;
      window.clearInterval(timer);
    };
  }, [load]);

  return {
    relations,
    loading,
    lastSuccessAt,
    error,
    refresh: () => void load(),
  };
}
