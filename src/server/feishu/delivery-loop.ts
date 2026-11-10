export type FeishuDeliveryLoopOptions = Readonly<{
  /** 处理一条投递；返回 null 表示当前没有可做的活。 */
  emit: () => Promise<string | null>;
  intervalMs?: number;
  maxPerTick?: number;
  backoffMaxMs?: number;
  onError?: (error: unknown) => void;
}>;

export type FeishuDeliveryLoop = Readonly<{
  start(): void;
  stop(): void;
  /** 有新投递时叫醒：立刻多跑一轮，不等空闲轮询。 */
  wake(): void;
  isRunning(): boolean;
}>;

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_MAX_PER_TICK = 20;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

/**
 * 有界的投递循环：空闲时按固定间隔轮询，唤醒时立刻跑；单轮最多处理若干条，
 * 所以一条一直失败的私聊不会饿死其他私聊。定时器 unref，进程不会被它挂住。
 */
export function createFeishuDeliveryLoop(options: FeishuDeliveryLoopOptions): FeishuDeliveryLoop {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxPerTick = options.maxPerTick ?? DEFAULT_MAX_PER_TICK;
  const backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let ticking = false;
  let dirty = false;
  let failures = 0;

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };
  const schedule = (delayMs: number) => {
    if (!running) return;
    clearTimer();
    timer = setTimeout(
      () => {
        timer = null;
        void tick();
      },
      Math.max(0, delayMs),
    );
    timer.unref?.();
  };
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // 诊断自己失败不能终止循环。
    }
  };

  const tick = async (): Promise<void> => {
    if (!running) return;
    if (ticking) {
      dirty = true;
      return;
    }
    ticking = true;
    try {
      let processed = 0;
      while (running && processed < maxPerTick) {
        const deliveryId = await options.emit();
        if (deliveryId === null) break;
        processed += 1;
      }
      failures = 0;
      schedule(processed >= maxPerTick || dirty ? 0 : intervalMs);
    } catch (error) {
      failures += 1;
      report(error);
      schedule(Math.min(intervalMs * 2 ** failures, backoffMaxMs));
    } finally {
      ticking = false;
      dirty = false;
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      schedule(0);
    },
    stop() {
      running = false;
      clearTimer();
    },
    wake() {
      if (!running) return;
      if (ticking) {
        dirty = true;
        return;
      }
      schedule(0);
    },
    isRunning: () => running,
  };
}
