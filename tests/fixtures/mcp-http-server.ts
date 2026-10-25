import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export async function startHttpMcpServer(port = 0) {
  const sessions = new Map<string, ServerResponse | null>();
  const callbacks = new Map<string, { response: ServerResponse; requestId: unknown }>();
  const stats = { initializes: 0, lists: 0, calls: 0, gets: 0, deletes: 0, pid: process.pid };
  const server = createServer(async (req, res) => {
    if (req.url === "/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(stats));
      return;
    }
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (req.method === "DELETE") {
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(404).end();
        return;
      }
      sessions.get(sessionId)?.end();
      sessions.delete(sessionId);
      stats.deletes++;
      res.writeHead(200).end();
      return;
    }
    if (req.method === "GET") {
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(400).end();
        return;
      }
      stats.gets++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      sessions.set(sessionId, res);
      const notice = JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      res.write(`: stream\r\nevent: message\r\ndata: ${notice}\r\n\r\n`);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.method === "initialize") {
      stats.initializes++;
      const id = randomUUID();
      sessions.set(id, null);
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": id });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "sprout-http-fixture", version: "1" },
          },
        }),
      );
      return;
    }
    if (!sessionId || !sessions.has(sessionId) || !req.headers["mcp-protocol-version"]) {
      res.writeHead(400).end();
      return;
    }
    if (message.method === "notifications/initialized" || !("id" in message)) {
      res.writeHead(202).end();
      return;
    }
    if (!("method" in message) && "id" in message) {
      const callback = callbacks.get(message.id);
      if (!callback) {
        res.writeHead(400).end();
        return;
      }
      callbacks.delete(message.id);
      callback.response.writeHead(200, { "Content-Type": "application/json" });
      callback.response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: callback.requestId,
          result: { callback: message.result },
        }),
      );
      res.writeHead(202).end();
      return;
    }
    if (message.method === "fixture/callback") {
      const stream = sessions.get(sessionId);
      if (!stream) {
        res.writeHead(409).end();
        return;
      }
      const id = randomUUID();
      callbacks.set(id, { response: res, requestId: message.id });
      stream.write(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id, method: "sampling/createMessage", params: { messages: [], maxTokens: 16 } })}\n\n`,
      );
      return;
    }
    if (message.method === "fixture/timeout") return;
    if (message.method === "fixture/malformed") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"wrong":true}');
      return;
    }
    if (message.method === "fixture/overflow") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${"x".repeat(131073)}\n\n`);
      return;
    }
    if (message.method === "tools/list") {
      stats.lists++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              {
                name: "wire_echo",
                description: "HTTP fixture",
                inputSchema: { type: "object", properties: { text: { type: "string" } } },
              },
            ],
          },
        }),
      );
      return;
    }
    if (message.method === "tools/call") {
      stats.calls++;
      const response = JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: message.params.arguments.text }],
          structuredContent: { delivered: true },
        },
      });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // Split an event across chunks, with a comment, CRLF and multiline data.
      res.write(": response\r\nevent: message\r\ndata: ");
      const split = response.indexOf(',"result"');
      res.write(response.slice(0, split + 1));
      res.write(`\r\ndata: ${response.slice(split + 1)}\r\n\r\n`);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Unknown method" },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP fixture port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    stats,
    close: async () => {
      for (const stream of sessions.values()) stream?.end();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startHttpMcpServer(Number(process.argv[2]));
}
