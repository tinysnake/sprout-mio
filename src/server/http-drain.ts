import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";

// Nitro's request/response hooks run before the body is sent, and request hook
// return values/errors are swallowed. Own the fetch boundary as well as transport.
export type NodeRequest = Request & {
  runtime?: { node?: { req: IncomingMessage; res?: ServerResponse } };
};

export class HttpDrain {
  draining = false;
  active = 0;
  private idle = new Set<() => void>();
  private servers = new Map<Server, Promise<void>>();

  begin(request: NodeRequest): () => void {
    const node = request.runtime?.node;
    const server = (node?.req.socket as (Socket & { server?: Server }) | undefined)?.server;
    if (server && !this.servers.has(server)) {
      this.servers.set(server, new Promise((resolve) => server.once("close", resolve)));
    }
    this.active += 1;
    let handled = false;
    let sent = !node?.res;
    let released = false;
    const release = () => {
      if (released || !handled || !sent) return;
      released = true;
      node?.res?.off("finish", completed);
      node?.res?.off("close", completed);
      this.active -= 1;
      if (this.active === 0) for (const resolve of this.idle) resolve();
    };
    const completed = () => {
      sent = true;
      release();
    };
    node?.res?.once("finish", completed);
    node?.res?.once("close", completed);
    return () => {
      handled = true;
      release();
    };
  }

  async wait(timeoutMs: number): Promise<void> {
    this.draining = true;
    // Let srvx's signal listener call close first. Observe the actual Node close
    // event, not srvx.close(), which can resolve early if close is already running.
    // CI/TEST install no srvx listener; the same microtask then closes the server.
    queueMicrotask(() => {
      for (const server of this.servers.keys()) {
        if (server.listening) server.close();
      }
    });
    let resolveIdle!: () => void;
    const idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
      if (this.active === 0) resolve();
      else this.idle.add(resolve);
    });
    let timer!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        Promise.all([idle, ...this.servers.values()]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`HTTP 排空超时 (${timeoutMs}ms)`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.idle.delete(resolveIdle);
    }
  }
}
