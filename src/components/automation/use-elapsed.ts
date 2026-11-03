import { useEffect, useState } from "react";

/**
 * 从某个时刻到现在的秒数。第一次渲染返回 `null`：服务端不知道浏览器眼里的「现在」，
 * 用服务端时间算出来的等待时长一定是错的，所以先不给数。
 */
export function useElapsedSeconds(
  since: string | null,
  now: () => number = Date.now,
): number | null {
  const [seconds, setSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (since === null) {
      setSeconds(null);
      return;
    }
    const started = Date.parse(since);
    const read = () =>
      setSeconds(Number.isNaN(started) ? null : Math.max(0, Math.floor((now() - started) / 1_000)));
    read();
    const timer = setInterval(read, 1_000);
    return () => clearInterval(timer);
  }, [since, now]);
  return seconds;
}
