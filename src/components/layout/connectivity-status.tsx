import { useEffect, useState } from "react";
import { useLocation, useRouter } from "@tanstack/react-router";
import { setConnected, useConnected } from "../../lib/connectivity";
import { safeReturnTarget } from "../../lib/return-target";

/** Network errors never imply an empty collection or a confirmed write. */
export function ConnectivityStatus() {
  const connected = useConnected();
  const router = useRouter();
  const location = useLocation();
  const [asOf, setAsOf] = useState<string | null>(null);
  useEffect(() => {
    localStorage.setItem("sprout:last-target", safeReturnTarget(location.href));
  }, [location.href]);
  useEffect(() => {
    let live = true;
    const original = window.fetch;
    let readIds: Promise<Record<string, string>> | undefined;
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const local = new URL(request.url).origin === window.location.origin;
      const write = !["GET", "HEAD", "OPTIONS"].includes(request.method);
      if (local && write && !navigator.onLine) {
        readIds ??= original("/pwa-reads.json")
          .then((response) => response.json())
          .catch(() => ({}));
        const id = new URL(request.url).pathname.split("/_serverFn/")[1];
        if (!id || !(await readIds)[id]) throw new TypeError("离线，未提交写入");
      }
      try {
        const response = await original(input, init);
        if (local && live) {
          const stale = response.headers.get("x-sprout-offline") === "1";
          if (stale) {
            setConnected(false);
            setAsOf(response.headers.get("x-sprout-cached-at"));
          } else if (response.ok) {
            setConnected(navigator.onLine);
            setAsOf(new Date().toLocaleString());
          }
        }
        return response;
      } catch (cause) {
        if (local && live && !(cause instanceof DOMException && cause.name === "AbortError"))
          setConnected(false);
        throw cause;
      }
    };
    const offline = () => setConnected(false);
    const online = () => {
      setConnected(true);
      void router.invalidate();
    };
    setConnected(navigator.onLine);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      live = false;
      window.fetch = original;
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [router]);
  if (connected) return null;
  return (
    <div
      role="status"
      data-testid="connectivity-status"
      className="shrink-0 border-b border-border bg-muted px-4 py-2 text-xs text-muted-foreground"
    >
      离线 · 最后更新 {asOf ?? "尚无成功读取记录"} ·
      当前事实可能已过期，写入不会排队；重新连接后自动刷新。
    </div>
  );
}

export function PwaRegistration() {
  useEffect(() => {
    if (import.meta.env.PROD && "serviceWorker" in navigator)
      void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(console.error);
    if (
      window.matchMedia("(display-mode: standalone)").matches &&
      window.location.pathname === "/"
    ) {
      const target = safeReturnTarget(localStorage.getItem("sprout:last-target"));
      if (target !== "/") window.location.replace(target);
    }
  }, []);
  return null;
}
