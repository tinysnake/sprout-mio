import { MCP_MAX_MESSAGE_BYTES } from "../contracts/mcp";

type Message = Record<string, unknown>;

function message(payload: string): Message {
  const value: unknown = JSON.parse(payload);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("jsonrpc" in value) ||
    value.jsonrpc !== "2.0" ||
    (!("method" in value && typeof value.method === "string") &&
      !("id" in value && ("result" in value || "error" in value)))
  )
    throw new Error("Invalid MCP JSON-RPC message");
  return value as Message;
}

/** One MCP HTTP attachment. Closing it never stops the target service. */
export class McpHttpConnection {
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private lifetime = new AbortController();
  private stream: Promise<void> | undefined;
  private pending = new Set<Promise<void>>();
  private queuedBytes = 0;
  private closing: Promise<void> | undefined;

  constructor(
    private url: string,
    private timeoutMs: number,
    private receive: (payload: Buffer) => void,
    private failed: () => void,
  ) {}

  setProtocolVersion(version: string) {
    this.protocolVersion = version;
  }

  private headers() {
    return {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...(this.protocolVersion ? { "MCP-Protocol-Version": this.protocolVersion } : {}),
    };
  }

  private deliver(payload: string) {
    if (Buffer.byteLength(payload) > MCP_MAX_MESSAGE_BYTES)
      throw new Error("MCP HTTP message exceeds budget");
    const value = message(payload);
    if (!this.lifetime.signal.aborted) this.receive(Buffer.from(JSON.stringify(value)));
    return value;
  }

  private async body(response: Response, sse: boolean, request?: Message) {
    if (!response.body) throw new Error("Missing MCP HTTP response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let data: string[] = [];
    let eventBytes = 0;
    let replied = !request || !("method" in request) || !("id" in request);
    const consume = (payload: string) => {
      const value = this.deliver(payload);
      if (request && value.id === request.id && ("result" in value || "error" in value)) {
        replied = true;
        if (request.method === "initialize" && value.result && typeof value.result === "object") {
          const version =
            "protocolVersion" in value.result ? value.result.protocolVersion : undefined;
          if (typeof version !== "string" || !version.length || version.length > 64)
            throw new Error("Invalid MCP protocol version");
          this.protocolVersion = version;
        }
      }
    };
    const line = (value: string) => {
      if (!value) {
        if (data.length) consume(data.join("\n"));
        data = [];
        eventBytes = 0;
      } else if (value.startsWith("data:")) {
        const part = value.slice(5).replace(/^ /, "");
        eventBytes += Buffer.byteLength(part) + (data.length ? 1 : 0);
        if (eventBytes > MCP_MAX_MESSAGE_BYTES) throw new Error("MCP SSE exceeds budget");
        data.push(part);
      }
    };
    try {
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        if (sse) {
          let index: number;
          while ((index = buffer.search(/[\r\n]/)) !== -1) {
            if (buffer[index] === "\r" && index === buffer.length - 1 && !chunk.done) break;
            line(buffer.slice(0, index));
            buffer = buffer.slice(index + (buffer.slice(index, index + 2) === "\r\n" ? 2 : 1));
          }
        }
        if (Buffer.byteLength(buffer) > MCP_MAX_MESSAGE_BYTES)
          throw new Error("MCP HTTP response exceeds budget");
        if (chunk.done) break;
      }
      if (!sse) consume(buffer);
      if (!replied) throw new Error("MCP HTTP stream ended before response");
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async send(payload: Buffer) {
    if (this.lifetime.signal.aborted) throw new Error("MCP HTTP attachment closed");
    const value = message(payload.toString("utf8"));
    const response = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: payload.toString("utf8"),
      redirect: "error",
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs)]),
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) {
      if (
        !/^[\x21-\x7e]{1,1024}$/.test(sessionId) ||
        (this.sessionId && sessionId !== this.sessionId)
      ) {
        await response.body?.cancel();
        throw new Error("MCP HTTP session changed");
      }
      this.sessionId = sessionId;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("MCP HTTP POST failed");
    }
    if (response.status === 202 || response.status === 204) {
      await response.body?.cancel();
      if ("method" in value && "id" in value)
        throw new Error("MCP request accepted without response");
    } else {
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (contentType !== "application/json" && contentType !== "text/event-stream") {
        await response.body?.cancel();
        throw new Error("Unsupported MCP HTTP response");
      }
      await this.body(response, contentType === "text/event-stream", value);
    }
    if (value.method === "notifications/initialized" && !this.stream)
      this.stream = this.readStream().catch(() => {
        if (!this.lifetime.signal.aborted) this.failed();
      });
  }

  enqueue(payload: Buffer) {
    if (this.pending.size >= 64 || this.queuedBytes + payload.length > 524288)
      throw new Error("MCP HTTP queue overflow");
    this.queuedBytes += payload.length;
    const pending = this.send(payload)
      .catch(() => {
        if (!this.lifetime.signal.aborted) this.failed();
      })
      .finally(() => {
        this.queuedBytes -= payload.length;
        this.pending.delete(pending);
      });
    this.pending.add(pending);
  }

  private async readStream() {
    const headerDeadline = new AbortController();
    const timer = setTimeout(() => headerDeadline.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.url, {
        headers: this.headers(),
        redirect: "error",
        signal: AbortSignal.any([this.lifetime.signal, headerDeadline.signal]),
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 405) {
      await response.body?.cancel();
      return;
    }
    if (
      !response.ok ||
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "text/event-stream"
    ) {
      await response.body?.cancel();
      throw new Error("MCP HTTP GET failed");
    }
    await this.body(response, true);
    if (!this.lifetime.signal.aborted) throw new Error("MCP HTTP GET stream ended");
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    this.closing = (async () => {
      await Promise.all([...this.pending, this.stream]);
      if (!this.sessionId) return;
      const response = await fetch(this.url, {
        method: "DELETE",
        headers: this.headers(),
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 2000)),
      });
      await response.body?.cancel();
      if (!response.ok && response.status !== 405) throw new Error("MCP HTTP DELETE failed");
    })();
    return this.closing;
  }
}

export async function probeMcpHttp(url: string, timeoutMs: number, signal?: AbortSignal) {
  let initialized = false;
  const connection = new McpHttpConnection(
    url,
    timeoutMs,
    (payload) => {
      const value = message(payload.toString("utf8"));
      initialized =
        value.id === 0 &&
        !!value.result &&
        typeof value.result === "object" &&
        "protocolVersion" in value.result &&
        typeof value.result.protocolVersion === "string" &&
        "capabilities" in value.result &&
        "serverInfo" in value.result;
    },
    () => {},
  );
  const abort = () => {
    void connection.close().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    await connection.send(
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "sprout-worker-probe", version: "1" },
          },
        }),
      ),
    );
    if (!initialized) throw new Error("MCP HTTP initialize failed");
  } finally {
    signal?.removeEventListener("abort", abort);
    await connection.close();
  }
}
