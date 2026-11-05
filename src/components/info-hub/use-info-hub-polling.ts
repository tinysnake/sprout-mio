import { useEffect, useRef, useState } from "react";
import { CHANGE_SAFETY_POLL_MS, chatTopic, projectTopic } from "../../contracts/change-stream";
import { INFO_HUB_POLLING } from "../../contracts/info-hub";
import { changeSource, onChangeStreamState, type ChangeSource } from "../../lib/change-stream";
import {
  infoHubRefreshInputSchema,
  infoHubRefreshResultSchema,
  type InfoHubRefreshInput,
  type InfoHubRefreshResult,
} from "../../contracts/info-hub-query";

type Refresh = (input: InfoHubRefreshInput, signal: AbortSignal) => Promise<unknown>;
export type PollingState =
  | "refreshing"
  | "current"
  | "hidden"
  | "offline"
  | "retrying"
  | "unauthorized"
  | "forbidden"
  | "not_found";
export class InfoHubAccessError extends Error {
  constructor(readonly code: "unauthorized" | "forbidden" | "not_found") {
    super(code);
  }
}
type Environment = {
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  window: Pick<Window, "addEventListener" | "removeEventListener">;
  navigator: Pick<Navigator, "onLine">;
};

/**
 * 同一秒内重复的恢复事件只算一次。恢复的代价是一次全量刷新（丢弃游标与 revision），
 * 而一次标签页恢复会先后发来 visibilitychange、online，重复付这份代价没有新信息。
 */
const RESUME_WINDOW_MS = 1_000;

/** One visible context owns one request. Resume discards both cursor and revision. */
export function createInfoHubPolling({
  input,
  refresh,
  onResult,
  onState,
  environment,
  changes,
  random = Math.random,
  now = Date.now,
}: {
  input: InfoHubRefreshInput;
  refresh: Refresh;
  onResult: (result: InfoHubRefreshResult) => void;
  onState?: (state: PollingState) => void;
  environment: Environment;
  /** 有推送时用安全间隔读一次 revision，没有推送退回轮询节奏。 */
  changes?: ChangeSource;
  random?: () => number;
  now?: () => number;
}) {
  const scope = infoHubRefreshInputSchema.parse(input);
  const { cursor: _cursor, ...query } =
    scope.query.view === "machine" ? { ...scope.query, cursor: undefined } : scope.query;
  let revision = scope.knownRevision;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | undefined;
  let stopped = false;
  let fullRefresh = true;
  let resumePending = false;
  let lastResumeAt: number | null = null;
  let failures = 0;
  let terminal = false;
  let pushPending = false;
  const { document, window, navigator } = environment;
  const paused = () =>
    document.visibilityState !== "visible" ? "hidden" : !navigator.onLine ? "offline" : null;
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  function schedule() {
    const pause = paused();
    if (stopped || pause || terminal) {
      if (pause) onState?.(pause);
      return;
    }
    // 推送可用时只保底读一次：漏掉的事件由 revision 比较自己纠回来。
    const interval = changes?.connected()
      ? scope.query.view === "project"
        ? CHANGE_SAFETY_POLL_MS.project
        : CHANGE_SAFETY_POLL_MS.chat
      : INFO_HUB_POLLING.intervalMs;
    const base = Math.min(
      interval * INFO_HUB_POLLING.backoffMultiplier ** Math.max(0, failures - 1),
      INFO_HUB_POLLING.maxBackoffMs,
    );
    const delay = Math.min(
      INFO_HUB_POLLING.maxBackoffMs,
      Math.round(base * (1 + (random() * 2 - 1) * INFO_HUB_POLLING.jitterRatio)),
    );
    timer = setTimeout(() => {
      void request();
    }, delay);
  }

  async function request() {
    clearTimer();
    const pause = paused();
    if (stopped || terminal || pause || inFlight) {
      if (pause) onState?.(pause);
      return;
    }
    const controller = new AbortController();
    inFlight = controller;
    const full = fullRefresh;
    fullRefresh = false;
    resumePending = false;
    const timeout = setTimeout(() => controller.abort(), INFO_HUB_POLLING.requestTimeoutMs);
    onState?.("refreshing");
    try {
      const result = infoHubRefreshResultSchema.parse(
        await refresh(
          infoHubRefreshInputSchema.parse({
            projectId: scope.projectId,
            query,
            ...(full || !revision ? {} : { knownRevision: revision }),
          }),
          controller.signal,
        ),
      );
      if (stopped || controller.signal.aborted) return;
      const resultProject = result.kind === "changed" ? result.view.projectId : result.projectId;
      const returnedScope = result.kind === "changed" ? result.view : result.query;
      if (
        resultProject !== scope.projectId ||
        ["view", "section", "chatId", "agentProfileId", "machineId"].some(
          (key) => Reflect.get(returnedScope, key) !== Reflect.get(query, key),
        )
      )
        throw new Error("Info Hub refresh returned another scope");
      revision = result.kind === "changed" ? result.view.revision : result.revision;
      failures = 0;
      onResult(result);
      onState?.("current");
    } catch (cause) {
      if (!stopped) {
        if (cause instanceof InfoHubAccessError) {
          terminal = true;
          pushPending = false;
          onState?.(cause.code);
        } else {
          failures += 1;
          onState?.(paused() ?? "retrying");
        }
      }
    } finally {
      clearTimeout(timeout);
      inFlight = undefined;
      if (!stopped && !terminal) {
        if (resumePending && !paused()) void request();
        else if (pushPending) {
          pushPending = false;
          if (paused()) schedule();
          else void request();
        } else schedule();
      }
    }
  }

  /** 推送到达：立刻读一次 revision；正在读就记下，等这一轮结束再读。 */
  function wake() {
    if (stopped || terminal || paused()) return;
    if (inFlight) {
      pushPending = true;
      return;
    }
    clearTimer();
    void request();
  }

  function resume() {
    const pause = paused();
    if (pause) {
      clearTimer();
      onState?.(pause);
      return;
    }
    const at = now();
    if (lastResumeAt !== null && at - lastResumeAt < RESUME_WINDOW_MS) {
      if (timer === undefined && !inFlight) schedule();
      return;
    }
    lastResumeAt = at;
    clearTimer();
    terminal = false;
    fullRefresh = true;
    revision = undefined;
    if (inFlight) resumePending = true;
    else void request();
  }
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("online", resume);
  window.addEventListener("offline", resume);
  const unsubscribe = changes?.subscribe(wake);
  // 断开后立刻退回轮询节奏，不让已经排上的安全间隔继续生效。
  const unsubscribeState = changes
    ? onChangeStreamState(() => {
        if (stopped || inFlight) return;
        clearTimer();
        schedule();
      })
    : undefined;
  void request();
  return () => {
    stopped = true;
    unsubscribe?.();
    unsubscribeState?.();
    clearTimer();
    inFlight?.abort();
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("online", resume);
    window.removeEventListener("offline", resume);
  };
}

export function useInfoHubPolling({
  input,
  refresh,
  onResult,
}: {
  input: InfoHubRefreshInput;
  refresh: Refresh;
  onResult: (result: InfoHubRefreshResult) => void;
}) {
  const [state, setState] = useState<PollingState>("refreshing");
  const callbacks = useRef({ refresh, onResult });
  callbacks.current = { refresh, onResult };
  const scope = JSON.stringify(input);
  useEffect(() => {
    const parsed = infoHubRefreshInputSchema.parse(JSON.parse(scope));
    const topics =
      parsed.query.view === "project"
        ? [projectTopic(parsed.projectId)]
        : [
            ...(parsed.query.view === "chat" ? [chatTopic(parsed.query.chatId)] : []),
            projectTopic(parsed.projectId),
          ];
    return createInfoHubPolling({
      input: parsed,
      refresh: (value, signal) => callbacks.current.refresh(value, signal),
      onResult: (result) => callbacks.current.onResult(result),
      onState: setState,
      changes: changeSource(topics),
      environment: { document, window, navigator },
    });
  }, [scope]);
  return state;
}
