export const EXECUTION_WAIT_DEFAULT_MS = 600_000;
export const EXECUTION_WAIT_MAX_MS = 900_000;
export const EXECUTION_WAIT_POLL_MS = 1_000;
export const SLEEP_MAX_MS = 600_000;
export const SLEEP_MIN_MS = 1;

export function clampExecutionWaitMs(requestedMs?: number): number {
  if (requestedMs === undefined || !Number.isFinite(requestedMs)) return EXECUTION_WAIT_DEFAULT_MS;
  return Math.min(EXECUTION_WAIT_MAX_MS, Math.max(EXECUTION_WAIT_POLL_MS, requestedMs));
}
