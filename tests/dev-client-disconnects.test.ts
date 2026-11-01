import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createServer, type Plugin, type ViteDevServer } from "vite-plus";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devClientDisconnects } from "../scripts/dev/vite-client-disconnects";

describe("dev client disconnects", () => {
  let server: ViteDevServer;
  let directory: string;
  let base: string;
  let replaceAbortError: boolean;
  let handled: Promise<Error>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "sprout-dev-disconnect-"));
    replaceAbortError = false;
    let finish: (error: Error) => void;
    handled = new Promise((resolve) => {
      finish = resolve;
    });
    const proxy: Plugin = {
      name: "body-reading-proxy-fixture",
      configureServer(devServer) {
        devServer.middlewares.use((req, res, next) => {
          if (req.url === "/upload") {
            void new Promise<never>((_resolve, reject) => {
              req.once("error", reject);
              req.resume();
            }).catch((error: Error) => {
              const forwarded = replaceAbortError
                ? Object.assign(new Error("upstream reset"), { code: "ECONNRESET" })
                : error;
              next(forwarded);
              finish(error);
            });
          } else if (req.url === "/failure") {
            next(Object.assign(new Error("upstream reset"), { code: "ECONNRESET" }));
          } else {
            res.end("healthy");
          }
        });
      },
    };
    server = await createServer({
      configFile: false,
      root: directory,
      logLevel: "silent",
      plugins: [devClientDisconnects(), proxy],
      server: { host: "127.0.0.1", port: 0, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("expected TCP listener");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await server?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function cancelUpload() {
    await new Promise<void>((resolve, reject) => {
      let canceled = false;
      const req = request(`${base}/upload`, {
        method: "POST",
        headers: { Expect: "100-continue", "Content-Length": "100000" },
      });
      req.once("continue", () => {
        canceled = true;
        req.destroy();
      });
      req.once("error", (error) => {
        if (!canceled) reject(error);
      });
      req.once("close", () => (canceled ? resolve() : reject(new Error("no 100 Continue"))));
      req.setTimeout(2000, () => req.destroy(new Error("no 100 Continue")));
      req.flushHeaders();
    });
    expect(await handled).toMatchObject({ message: "aborted", code: "ECONNRESET" });
  }

  it("a canceled upload does not broadcast a global overlay and leaves the server usable", async () => {
    const send = vi.spyOn(server.environments.client.hot, "send");
    await cancelUpload();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    expect(await (await fetch(base)).text()).toBe("healthy");
  });

  it("an independent reset still broadcasts an overlay even after the incoming request is canceled", async () => {
    replaceAbortError = true;
    const send = vi.spyOn(server.environments.client.hot, "send");
    await cancelUpload();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        err: expect.objectContaining({ message: "upstream reset" }),
      }),
    );
  });

  it("a reset on a connected request still returns 500 and broadcasts an overlay", async () => {
    const send = vi.spyOn(server.environments.client.hot, "send");
    expect((await fetch(`${base}/failure`)).status).toBe(500);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        err: expect.objectContaining({ message: "upstream reset" }),
      }),
    );
  });
});
