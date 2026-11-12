/** 等待预算上限：创建型工具与 `sprout_remote_execution_wait` 共用。 */
export const EXECUTION_WAIT_MAX_MS = 900_000;
/** 轮询既有 `execution_get` 的间隔。 */
export const EXECUTION_WAIT_POLL_MS = 1_000;
/** 创建型远端工具默认阻塞多久；`blockMs: 0` 表示提交后立即返回。 */
export const EXECUTION_BLOCK_DEFAULT_MS = 30_000;
/** `sprout_remote_execution_wait` 续等一个已存在的 execution 时的默认预算。 */
export const EXECUTION_WAIT_DEFAULT_MS = 600_000;
export const SLEEP_MAX_MS = 600_000;
export const SLEEP_MIN_MS = 1;

/**
 * 创建型工具的等待预算按「钳断」而不是校验处理：非有限值退回默认，负数取 0，超过上限截到上限。
 * `fallbackMs` 由调用方给出，创建型工具是 `EXECUTION_BLOCK_DEFAULT_MS`。0 是合法值。
 */
export function clampExecutionBlockMs(
  requestedMs: number | undefined,
  fallbackMs: number,
): number {
  if (requestedMs === undefined || !Number.isFinite(requestedMs)) return fallbackMs;
  return Math.min(EXECUTION_WAIT_MAX_MS, Math.max(0, Math.trunc(requestedMs)));
}

/**
 * `sprout_remote_execution_wait` 的续等预算：默认 10 分钟，最多 15 分钟，不足 1 秒按 1 秒算。
 */
export function clampExecutionWaitMs(requestedMs?: number): number {
  if (requestedMs === undefined || !Number.isFinite(requestedMs)) return EXECUTION_WAIT_DEFAULT_MS;
  return Math.min(EXECUTION_WAIT_MAX_MS, Math.max(EXECUTION_WAIT_POLL_MS, requestedMs));
}
