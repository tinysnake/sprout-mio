import type { RunActivity, RunActivityStep, RunActivityStatus } from "../../contracts/agent-run";
import { RUN_ACTIVITY_ENTRY_LIMIT } from "../../contracts/agent-run";
import type { PiHostProgress } from "./protocol";

/** 进程内的 run 活动快照；时间存毫秒，读出时再转 ISO。 */
export type RunActivitySnapshot = {
  current: RunActivityStep | null;
  entries: RunActivityStep[];
  updatedAt: number;
};

const scope = globalThis as typeof globalThis & {
  sproutRunActivity?: Map<string, RunActivitySnapshot>;
};

function activityStore(): Map<string, RunActivitySnapshot> {
  return (scope.sproutRunActivity ??= new Map());
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

function clipDetail(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 199)}…` : oneLine;
}

function finishedStep(
  step: RunActivityStep,
  at: number,
  status: RunActivityStatus,
  durationMs?: number,
): RunActivityStep {
  const started = Date.parse(step.startedAt);
  const measured = durationMs ?? (Number.isFinite(started) ? Math.max(0, at - started) : undefined);
  return {
    ...step,
    status,
    finishedAt: iso(at),
    ...(measured === undefined ? {} : { durationMs: Math.round(measured) }),
  };
}

function prependEntry(entries: RunActivityStep[], step: RunActivityStep): RunActivityStep[] {
  return [step, ...entries].slice(0, RUN_ACTIVITY_ENTRY_LIMIT);
}

/** 只替换已有记录；已被上限挤掉的旧步骤不再回填，避免历史顺序倒错。 */
function replaceEntry(entries: RunActivityStep[], step: RunActivityStep): RunActivityStep[] {
  const index = entries.findIndex((entry) => entry.id === step.id);
  if (index === -1) return entries;
  const next = [...entries];
  next[index] = step;
  return next;
}

function fromEvent(event: PiHostProgress, at: number, id: string): RunActivityStep | undefined {
  if (!event.activity) return undefined;
  return {
    id,
    kind: event.activity.kind,
    label: event.activity.label,
    detail: event.activity.detail,
    toolName: event.activity.toolName,
    startedAt: iso(at),
    status: "running",
  };
}

/**
 * 单条 progress 驱动的活动转移。只有工具调用会写工作记录；assistant 文本
 * 不进入这组记录，返回 `undefined` 让调用方保留上一份快照。
 */
export function reduceRunActivity(
  previous: RunActivitySnapshot | undefined,
  event: PiHostProgress,
  at: number,
): RunActivitySnapshot | undefined {
  if (event.kind === "text_delta") return undefined;

  const entries = previous?.entries ?? [];
  const current = previous?.current ?? null;

  if (event.kind === "mcp_surface_failed") {
    const step: RunActivityStep = {
      id: `mcp_surface:${at}`,
      kind: "mcp",
      label: "MCP 工具面刷新失败",
      ...(event.message ? { detail: clipDetail(event.message) } : {}),
      toolName: "mcp",
      startedAt: iso(at),
      finishedAt: iso(at),
      status: "error",
      durationMs: 0,
    };
    return {
      current,
      entries: prependEntry(entries, step),
      updatedAt: at,
    };
  }

  if (event.kind === "tool_start") {
    if (!event.activity) return undefined;
    const step = fromEvent(event, at, event.toolCallId ?? `${event.activity.toolName}:${at}`);
    if (!step) return undefined;
    if (current?.id === step.id) {
      const same = { ...step, startedAt: current.startedAt };
      return { current: same, entries: replaceEntry(entries, same), updatedAt: at };
    }
    const closed = current ? replaceEntry(entries, finishedStep(current, at, "done")) : entries;
    return {
      current: step,
      entries: prependEntry(closed, step),
      updatedAt: at,
    };
  }

  const status: RunActivityStatus = event.isError ? "error" : "done";
  const target =
    current && (!event.toolCallId || current.id === event.toolCallId)
      ? current
      : entries.find((entry) => entry.id === event.toolCallId);
  if (target) {
    const step = finishedStep(target, at, status, event.durationMs);
    return {
      current: current?.id === step.id ? null : current,
      entries: replaceEntry(entries, step),
      updatedAt: at,
    };
  }

  // 没看到 start 也要留下 end 的事实：宁可直接给一条已完成记录。
  if (!event.activity) return undefined;
  const step = fromEvent(event, at, event.toolCallId ?? `${event.activity.toolName}:${at}`);
  if (!step) return undefined;
  return {
    current,
    entries: prependEntry(entries, finishedStep(step, at, status, event.durationMs)),
    updatedAt: at,
  };
}

export function recordRunActivity(runId: string, event: PiHostProgress, at: number): void {
  const store = activityStore();
  const next = reduceRunActivity(store.get(runId), event, at);
  if (next) store.set(runId, next);
}

/** 活动只在 run 仍在运行时有意义；run 收尾后由 executeRun 清掉。 */
export function readRunActivity(runId: string): RunActivity | undefined {
  const snapshot = activityStore().get(runId);
  if (!snapshot || snapshot.entries.length === 0) return undefined;
  return {
    current: snapshot.current,
    entries: snapshot.entries,
    updatedAt: iso(snapshot.updatedAt),
  };
}

export function clearRunActivity(runId: string): void {
  activityStore().delete(runId);
}
