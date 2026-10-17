export type RateLimitDecision = { allowed: boolean; retryAfterMs: number };
export type RateLimitState = ReadonlyMap<string, readonly number[]>;
export type RateLimitPolicy = { max: number; windowMs: number; maxKeys: number };

/** 纯状态转换；窗口为 (now - windowMs, now]，拒绝不延长窗口。 */
export function consumeSlidingWindow(
  previous: RateLimitState,
  key: string,
  policy: RateLimitPolicy,
  now: number,
): { state: RateLimitState; decision: RateLimitDecision } {
  const state = new Map<string, readonly number[]>();
  for (const [storedKey, timestamps] of previous) {
    const active = timestamps.filter((at) => at > now - policy.windowMs);
    if (active.length) state.set(storedKey, active);
  }
  const timestamps = state.get(key) ?? [];
  if (timestamps.length >= policy.max) {
    return {
      state,
      decision: { allowed: false, retryAfterMs: timestamps[0]! + policy.windowMs - now },
    };
  }
  // 容量满时不驱逐活跃 key，否则换账号可清掉受害账号的预算。
  if (!state.has(key) && state.size >= policy.maxKeys) {
    const expiresAt = Math.min(...[...state.values()].map((values) => values.at(-1)!));
    return {
      state,
      decision: { allowed: false, retryAfterMs: expiresAt + policy.windowMs - now },
    };
  }
  state.set(key, [...timestamps, now]);
  return { state, decision: { allowed: true, retryAfterMs: 0 } };
}

/** 同步消费避免并行请求越过预算；外部只注入策略与毫秒时钟。 */
export function createSlidingWindowLimiter({
  max,
  windowMs,
  maxKeys = 10_000,
  now = Date.now,
}: Omit<RateLimitPolicy, "maxKeys"> & { maxKeys?: number; now?: () => number }) {
  for (const value of [max, windowMs, maxKeys]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("限流策略必须是正整数");
  }
  let state: RateLimitState = new Map();
  let lastTime = -Infinity;
  return (key: string): RateLimitDecision => {
    lastTime = Math.max(lastTime, now());
    const result = consumeSlidingWindow(state, key, { max, windowMs, maxKeys }, lastTime);
    state = result.state;
    return result.decision;
  };
}
