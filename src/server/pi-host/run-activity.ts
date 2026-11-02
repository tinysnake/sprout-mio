import type {
  RunActivity,
  RunActivityStep,
  RunActivityStatus,
} from "../../contracts/agent-run";
import type { PiHostProgress } from "./protocol";

const RECENT_LIMIT = 5;
const TEXT_LIMIT = 240;

/** 进程内的 run 活动快照；时间存毫秒，读出时再转 ISO。 */
export type RunActivitySnapshot = {
  current: RunActivityStep | null;
  recent: RunActivityStep[];
  text: string;
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
  const measured =
    durationMs ?? (Number.isFinite(started) ? Math.max(0, at - started) : undefined);
  return {
    ...step,
    status,
    finishedAt: iso(at),
    ...(measured === undefined ? {} : { durationMs: Math.round(measured) }),
  };
}

function prependRecent(recent: RunActivityStep[], step: RunActivityStep): RunActivityStep[] {
  return [step, ...recent].slice(0, RECENT_LIMIT);
}

function fromEvent(
  event: PiHostProgress,
  at: number,
  id: string,
): RunActivityStep | undefined {
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
 * 单条 progress 驱动的状态转移。返回 `undefined` 表示这条事件不改变活动
 * （例如空文本增量），调用方保留上一份快照。
 */
export function reduceRunActivity(
  previous: RunActivitySnapshot | undefined,
  event: PiHostProgress,
  at: number,
): RunActivitySnapshot | undefined {
  if (event.kind === "text_delta") {
    if (!event.text) return undefined;
    return {
      current: previous?.current ?? null,
      recent: previous?.recent ?? [],
      text: `${previous?.text ?? ""}${event.text}`.slice(-TEXT_LIMIT),
      updatedAt: at,
    };
  }

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
      current: previous?.current ?? null,
      recent: prependRecent(previous?.recent ?? [], step),
      text: previous?.text ?? "",
      updatedAt: at,
    };
  }

  if (event.kind === "tool_start") {
    if (!event.activity) return undefined;
    const step = fromEvent(event, at, event.toolCallId ?? `${event.activity.toolName}:${at}`);
    if (!step) return undefined;
    const current = previous?.current ?? null;
    if (previous && current?.id === step.id)
      return { ...previous, current: { ...step, startedAt: current.startedAt }, updatedAt: at };
    return {
      current: step,
      recent: current
        ? prependRecent(previous?.recent ?? [], finishedStep(current, at, "done"))
        : (previous?.recent ?? []),
      text: "",
      updatedAt: at,
    };
  }

  const current = previous?.current ?? null;
  if (previous && current && (!event.toolCallId || current.id === event.toolCallId)) {
    const status: RunActivityStatus = event.isError ? "error" : "done";
    const step = finishedStep(current, at, status, event.durationMs);
    return {
      ...previous,
      current: null,
      recent: prependRecent(previous?.recent ?? [], step),
      updatedAt: at,
    };
  }

  // 没看到 start 也要留下 end 的事实：宁可直接给一条已完成步骤。
  if (!event.activity) return undefined;
  const step = fromEvent(event, at, event.toolCallId ?? `${event.activity.toolName}:${at}`);
  if (!step) return undefined;
  const done = finishedStep(step, at, event.isError ? "error" : "done", event.durationMs);
  return {
    current: previous?.current ?? null,
    recent: prependRecent(previous?.recent ?? [], done),
    text: previous?.text ?? "",
    updatedAt: at,
  };
}

export function recordRunActivity(runId: string, event: PiHostProgress): void {
  const store = activityStore();
  const next = reduceRunActivity(store.get(runId), event, Date.now());
  if (next) store.set(runId, next);
}

/** 活动只在 run 仍在运行时有意义；run 收尾后由 executeRun 清掉。 */
export function readRunActivity(runId: string): RunActivity | undefined {
  const snapshot = activityStore().get(runId);
  if (!snapshot || (!snapshot.current && snapshot.recent.length === 0 && !snapshot.text))
    return undefined;
  const text = snapshot.text.trim();
  return {
    current: snapshot.current,
    recent: snapshot.recent,
    ...(text ? { text } : {}),
    updatedAt: iso(snapshot.updatedAt),
  };
}

export function clearRunActivity(runId: string): void {
  activityStore().delete(runId);
}
