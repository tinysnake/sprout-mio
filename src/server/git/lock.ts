const chains = new Map<string, Promise<unknown>>();

/**
 * 进程内按 key 串行化 git 操作。P3 是单宿主进程，进程内互斥加
 * repo_checkout 的 status 行足以表达同一工作副本的操作序列；
 * 不同 key（不同 Project）互不阻塞。
 */
export function withRepoLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const result = previous.then(task);
  chains.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}
