import { definePlugin } from "nitro";
import { isMainThread } from "node:worker_threads";
import { HttpDrain } from "./http-drain";
import { initializeRequestContext, getRequestContext, REQUEST_ID_HEADER } from "./request-context";
import {
  loadServerFnNames,
  logRequest,
  serverFunctionId,
  type RequestLogRecord,
} from "./request-log";
import {
  beginRuntimeShutdown,
  failRuntimeShutdown,
  runtimeReady,
  shutdownRuntime,
  startRuntime,
} from "./runtime";

const entryScope = globalThis as typeof globalThis & {
  sproutSignalHooks?: boolean;
  sproutHttpDrain?: HttpDrain;
  sproutDrainShutdown?: Promise<void>;
};
const drain = (entryScope.sproutHttpDrain ??= new HttpDrain());
const prerender = process.env.TSS_PRERENDERING === "true";

function drainRuntime(reason: string): Promise<void> {
  if (entryScope.sproutDrainShutdown) return entryScope.sproutDrainShutdown;
  drain.draining = true;
  console.log("[runtime] draining", JSON.stringify({ reason, activeRequests: drain.active }));
  entryScope.sproutDrainShutdown = (async () => {
    // Start both deadlines at signal delivery, including any startup wait.
    const drained = drain.wait(8000);
    await Promise.all([beginRuntimeShutdown(reason), drained]);
    console.log("[runtime] drained");
    await shutdownRuntime(reason);
  })();
  return entryScope.sproutDrainShutdown;
}

if (!prerender) {
  // srvx otherwise forcibly closes connections after 5s, before our 8s drain.
  const srvxTimeout = Number.parseInt(process.env.SERVER_SHUTDOWN_TIMEOUT ?? "");
  if (!Number.isFinite(srvxTimeout) || srvxTimeout < 10) {
    process.env.SERVER_SHUTDOWN_TIMEOUT = "10";
  }
  if (isMainThread && !entryScope.sproutSignalHooks) {
    entryScope.sproutSignalHooks = true;
    let signalled = false;
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        if (signalled) return;
        signalled = true;
        const deadline = setTimeout(() => {
          failRuntimeShutdown(new Error(`关闭超时 (9000ms): ${signal}`));
          process.exit(1);
        }, 9000);
        void drainRuntime(signal).then(
          () => {
            clearTimeout(deadline);
            process.exit(0);
          },
          (error) => {
            failRuntimeShutdown(error);
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

// Resolve diagnostics at module initialization; Nitro does not await plugin callbacks.
const recordDiagnostic = prerender ? undefined : (await import("./diagnostics")).recordDiagnostic;

function observeRequest(
  request: Request,
  requestId: string,
  startedAt: number,
  response: Response,
): Response {
  const path = new URL(request.url).pathname;
  const fnId = serverFunctionId(path);
  const base: Omit<RequestLogRecord, "bytes" | "complete" | "ms"> = {
    requestId,
    method: request.method,
    path,
    fn: fnId ? (loadServerFnNames().get(fnId) ?? null) : null,
    fnId,
    status: response.status,
  };
  // 一个请求只允许一行：content-length、flush、cancel 与流错误可能同时到达。
  let emitted = false;
  const emit = (bytes: number, complete: boolean) => {
    if (emitted) return;
    emitted = true;
    logRequest({
      ...base,
      bytes,
      complete,
      ms: Math.round((performance.now() - startedAt) * 10) / 10,
    });
  };

  const declared = response.headers.get("content-length");
  const declaredBytes = declared === null ? Number.NaN : Number.parseInt(declared, 10);
  if (Number.isFinite(declaredBytes)) {
    emit(declaredBytes, true);
    return response;
  }
  if (!response.body) {
    emit(0, true);
    return response;
  }

  let bytes = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      emit(bytes, true);
    },
  });
  // 客户端 abort 时 counter 的可读端被取消，writable 随之报错，pipeTo 落到第二个回调。
  void response.body.pipeTo(counter.writable).then(
    () => emit(bytes, true),
    () => emit(bytes, false),
  );
  return new Response(counter.readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export default definePlugin((app) => {
  if (prerender) return;
  app.hooks.hook("close", () => drainRuntime("nitro.close"));
  const fetch = app.fetch;
  app.fetch = async (request) => {
    const { requestId } = initializeRequestContext(request);
    if (drain.draining) {
      return Response.json(
        { ok: false, ready: false, phase: "stopping", requestId },
        {
          status: 503,
          headers: {
            [REQUEST_ID_HEADER]: requestId,
            "cache-control": "no-store",
            connection: "close",
            "retry-after": "1",
          },
        },
      );
    }
    const startedAt = performance.now();
    const handled = drain.begin(request);
    try {
      return observeRequest(request, requestId, startedAt, await fetch(request));
    } finally {
      handled();
    }
  };
  app.hooks.hook("request", async (event) => {
    if (new URL(event.req.url).pathname !== "/api/health") await runtimeReady;
  });
  app.hooks.hook("response", (response, event) => {
    const { requestId } = getRequestContext(event.req);
    response.headers.set(REQUEST_ID_HEADER, requestId);
    if (drain.draining || !recordDiagnostic) return;
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
