import { definePlugin } from "nitro";
import { isMainThread } from "node:worker_threads";
import { initializeRequestContext, getRequestContext, REQUEST_ID_HEADER } from "./request-context";
import { runtimeReady, shutdownRuntime, startRuntime } from "./runtime";

const entryScope = globalThis as typeof globalThis & { sproutSignalHooks?: boolean };
const prerender = process.env.TSS_PRERENDERING === "true";

if (!prerender) {
  if (isMainThread && !entryScope.sproutSignalHooks) {
    entryScope.sproutSignalHooks = true;
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        const deadline = setTimeout(() => {
          console.error("[runtime] 关闭超时", signal);
          process.exit(1);
        }, 9000);
        void shutdownRuntime(signal).then(
          () => {
            clearTimeout(deadline);
            process.exit(0);
          },
          (error) => {
            console.error("[runtime] 关闭失败", error);
            clearTimeout(deadline);
            process.exit(1);
          },
        );
      });
    }
  }
  try {
    await startRuntime();
  } catch (error) {
    console.error("[runtime] 启动失败", error instanceof Error ? error.message : "未知错误");
    throw error;
  }
}

export default definePlugin((app) => {
  if (prerender) return;
  app.hooks.hook("close", () => shutdownRuntime("nitro.close"));
  app.hooks.hook("request", async (event) => {
    initializeRequestContext(event.req);
    if (new URL(event.req.url).pathname !== "/api/health") await runtimeReady;
  });
  app.hooks.hook("response", async (response, event) => {
    const { requestId } = getRequestContext(event.req);
    response.headers.set(REQUEST_ID_HEADER, requestId);
    const { recordDiagnostic } = await import("./diagnostics");
    recordDiagnostic({
      level: response.status >= 500 ? "error" : "info",
      event: "http.response",
      requestId,
      message: "HTTP 请求完成",
      data: {
        method: event.req.method,
        pathname: new URL(event.req.url).pathname,
        status: response.status,
      },
    });
  });
});
