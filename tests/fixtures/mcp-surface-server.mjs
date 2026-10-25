/**
 * x3 用的真实 MCP server（stdio，官方 `@modelcontextprotocol/sdk`，不 mock 协议）。
 *
 * 为什么不用 `server-everything`：它的 `trigger-list-changed` 只发通知、不改目录，
 * 无法证明"目录真的变了"。这里用官方 SDK 起一个真实 server，`add-tool` 会真的往
 * `tools/list` 里加一条并发 `notifications/tools/list_changed`——这正是 B2 的场景。
 *
 * 只暴露断言需要的工具，输出里不含任何 secret。
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const sdkRoot = resolve(
  "node_modules/.pnpm/@modelcontextprotocol+sdk@1.32.1_zod@4.6.7/node_modules/@modelcontextprotocol/sdk/dist/esm",
);
const { Server } = await import(pathToFileURL(`${sdkRoot}/server/index.js`).href);
const { StdioServerTransport } = await import(pathToFileURL(`${sdkRoot}/server/stdio.js`).href);
const types = await import(pathToFileURL(`${sdkRoot}/types.js`).href);

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const tools = [
  { name: "echo", description: "echo text", inputSchema: { type: "object", properties: {} } },
  {
    name: "picture",
    description: "image plus structuredContent",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add-tool",
    description: "register a tool and send list_changed",
    inputSchema: { type: "object", properties: {} },
  },
];
let extra = 0;

const server = new Server(
  { name: "x3-surface-server", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(types.ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(types.CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  if (name === "echo") return { content: [{ type: "text", text: "echo:ok" }] };
  if (name === "picture")
    return {
      content: [
        { type: "image", data: PNG, mimeType: "image/png" },
        { type: "text", text: "picture-done" },
      ],
      structuredContent: { ok: true, n: 42 },
    };
  if (name === "add-tool") {
    extra += 1;
    const added = `added-${extra}`;
    tools.push({
      name: added,
      description: added,
      inputSchema: { type: "object", properties: {} },
    });
    await server.sendToolListChanged();
    return { content: [{ type: "text", text: added }] };
  }
  if (name.startsWith("added-")) return { content: [{ type: "text", text: `called:${name}` }] };
  return { content: [{ type: "text", text: "unknown" }], isError: true };
});

await server.connect(new StdioServerTransport());
