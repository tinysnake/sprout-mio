const listeners = new Set<() => void>();

/**
 * 让运行时调度器在写入提交后重新计算下一次到期时间。
 * 只传递“有变化”这件事；具体要扫什么由调度器自己决定。
 */
export function signalSchedulerChange(): void {
  queueMicrotask(() => {
    for (const listener of listeners) listener();
  });
}

export function onSchedulerChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
