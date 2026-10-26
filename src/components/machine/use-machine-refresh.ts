import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

export function useMachineRefresh() {
  const router = useRouter();
  useEffect(() => {
    let stopped = false;
    let refreshing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function schedule() {
      clearTimeout(timer);
      if (stopped || refreshing || document.visibilityState !== "visible") return;
      timer = setTimeout(async () => {
        if (stopped || document.visibilityState !== "visible") return;
        refreshing = true;
        try {
          await router.invalidate();
        } catch {
          // Retry quietly on the next visible cycle; manual refresh stays available.
        } finally {
          refreshing = false;
          schedule();
        }
      }, 5000);
    }
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [router]);
  return router;
}
