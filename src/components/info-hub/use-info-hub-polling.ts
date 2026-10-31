import { useEffect, useRef, useState } from "react";
import { INFO_HUB_POLLING } from "../../contracts/info-hub";
import {
  infoHubRefreshInputSchema,
  infoHubRefreshResultSchema,
  type InfoHubRefreshInput,
  type InfoHubRefreshResult,
} from "../../contracts/info-hub-query";

type Refresh = (input: InfoHubRefreshInput, signal: AbortSignal) => Promise<unknown>;
type PollingState = "refreshing" | "current" | "hidden" | "offline" | "retrying";
type Environment = {
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  window: Pick<Window, "addEventListener" | "removeEventListener">;
  navigator: Pick<Navigator, "onLine">;
};

/** One visible context owns one request. Resume discards both cursor and revision. */
export function createInfoHubPolling({
  input,
  refresh,
  onResult,
  onState,
  environment,
  random = Math.random,
}: {
  input: InfoHubRefreshInput;
  refresh: Refresh;
  onResult: (result: InfoHubRefreshResult) => void;
  onState?: (state: PollingState) => void;
  environment: Environment;
  random?: () => number;
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
  let failures = 0;
  const { document, window, navigator } = environment;
  const paused = () =>
    document.visibilityState !== "visible" ? "hidden" : !navigator.onLine ? "offline" : null;
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  function schedule() {
    const pause = paused();
    if (stopped || pause) {
      if (pause) onState?.(pause);
      return;
    }
    const base = Math.min(
      INFO_HUB_POLLING.intervalMs * INFO_HUB_POLLING.backoffMultiplier ** Math.max(0, failures - 1),
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
    if (stopped || pause || inFlight) {
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
    } catch {
      if (!stopped) {
        failures += 1;
        onState?.("retrying");
      }
    } finally {
      clearTimeout(timeout);
      inFlight = undefined;
      if (!stopped) {
        if (resumePending && !paused()) void request();
        else schedule();
      }
    }
  }

  function resume() {
    clearTimer();
    const pause = paused();
    if (pause) {
      onState?.(pause);
      return;
    }
    fullRefresh = true;
    revision = undefined;
    if (inFlight) resumePending = true;
    else void request();
  }
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("online", resume);
  window.addEventListener("offline", resume);
  void request();
  return () => {
    stopped = true;
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
  useEffect(
    () =>
      createInfoHubPolling({
        input: infoHubRefreshInputSchema.parse(JSON.parse(scope)),
        refresh: (value, signal) => callbacks.current.refresh(value, signal),
        onResult: (result) => callbacks.current.onResult(result),
        onState: setState,
        environment: { document, window, navigator },
      }),
    [scope],
  );
  return state;
}
