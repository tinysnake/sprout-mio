import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";

/** No cached target is different from an empty target or a confirmed deletion. */
export function RouteReadError({ error }: { error: Error }) {
  const router = useRouter();
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [pending, setPending] = useState(false);
  async function retry() {
    if (pending) return;
    setPending(true);
    try {
      await router.invalidate({ sync: true });
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    const reconnect = () => {
      setOnline(true);
      void router.invalidate();
    };
    const disconnect = () => setOnline(false);
    window.addEventListener("online", reconnect);
    window.addEventListener("offline", disconnect);
    return () => {
      window.removeEventListener("online", reconnect);
      window.removeEventListener("offline", disconnect);
    };
  }, [router]);
  return (
    <main className="mx-auto max-w-xl space-y-4 px-6 py-16">
      <h1 className="text-xl font-semibold">
        {online ? "页面读取失败" : "当前页面没有可用的离线副本"}
      </h1>
      {!online && (
        <p
          role="status"
          data-testid="connectivity-status"
          className="text-sm text-muted-foreground"
        >
          离线 · 最后更新 尚无可用记录 · 联网后重新读取；未提交任何写入。
        </p>
      )}
      <p role="alert" className="break-words text-sm text-muted-foreground">
        {online ? error.message : "无法确认此目标的当前内容，请联网后重试。"}
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <Button variant="outline" disabled={!online || pending} onClick={() => void retry()}>
          重新读取
        </Button>
        <Link to="/" className="text-sm underline">
          返回首页
        </Link>
      </div>
    </main>
  );
}
