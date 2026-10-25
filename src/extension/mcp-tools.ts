import type { McpCallToolResult, McpTool, PiMcpModule } from "./mcp-pi-types";
import type { McpRegistration, SproutMcpConnection } from "./mcp-client";
import { toolParameters } from "./mcp-load";
import type { SproutExtensionAPI, SproutToolResult } from "./types";

/**
 * 工具名前缀沿用冻结设计 §8.5 的 `mcp__<server>__<tool>`：它与 Pi 内建 MCP 的命名一致，
 * 也是 §10 反证「宿主 `mcp.json` 不入工具面」要断言的形状（快照里不含 `mcp__sentinel__*`）。
 */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/**
 * order 7 的工具面围栏在宿主侧落实：`registration.toolAllowlist` 是精确名单（禁 `*`），
 * 只有名单内的工具进入模型工具面；省略名单表示该登记的全部工具。
 * 服务端不读 `tools/call` 的 `params.name`，因此这是**工具面**约束而不是细粒度安全 ACL。
 */
export function visibleTools(registration: McpRegistration, tools: readonly McpTool[]): McpTool[] {
  const allowlist = registration.toolAllowlist;
  if (!allowlist) return [...tools];
  const allowed = new Set(allowlist);
  return tools.filter((tool) => allowed.has(tool.name));
}

function describe(registration: McpRegistration, tool: McpTool): string {
  const base =
    tool.description?.trim() ||
    `调用显式登记的 MCP server「${registration.name}」提供的 ${tool.name}`;
  return `${base}（来自 Project 内显式登记的远端 MCP server「${registration.name}」，经 Sprout 受认证 Worker 通道到达 Machine，绝非宿主本地工具；${registration.transport === "stdio" ? "stdio" : "streamableHttp"} 进程在 Machine 上运行）`;
}

/**
 * MCP `content` 块 → Pi 工具结果的内容块。
 *
 * pi-mcp 的 `toLlmContent`（`dist/protocol/content.js`）已经做过一次形状收敛：`text` 与
 * `image` 原样透传，`audio`、`resource_link`、二进制 `resource` 变成占位或短文本，未知
 * 类型变成 `[unsupported MCP content ...]`。这里只做类型对齐，不再重新解释块语义——
 * 上一版把非 text 块 `JSON.stringify` 成文本，等于把图片降级成 base64 字符串，模型拿
 * 不到 `ImageContent`。
 */
function content(result: McpCallToolResult, piMcp: PiMcpModule): SproutToolResult["content"] {
  const mapped: SproutToolResult["content"] = [];
  for (const block of piMcp.toLlmContent(result)) {
    if (block.type === "text" && typeof block.text === "string")
      mapped.push({ type: "text", text: block.text });
    else if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    )
      mapped.push({ type: "image", data: block.data, mimeType: block.mimeType });
    // 走到这里说明 pi-mcp 给出了第三种形状；照实写出来，不假装是图片也不静默丢掉。
    else mapped.push({ type: "text", text: JSON.stringify(block) });
  }
  if (mapped.length === 0) mapped.push({ type: "text", text: "(空结果)" });
  return mapped;
}

function failure(message: string): SproutToolResult {
  const details = { outcome: "failed", error: { code: "validation_failed", message } };
  return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: true };
}

/**
 * 把远端 server 的工具按前缀登记成 Pi 工具。每次调用前复核当前授权是否仍成立
 * （`stillAllowed`），撤权后同一 session 不再被当作可用通道。
 */
export function registerMcpTools(
  pi: Pick<SproutExtensionAPI, "registerTool">,
  piMcp: PiMcpModule,
  connection: SproutMcpConnection,
  options: { stillAllowed?: () => Promise<boolean> } = {},
): string[] {
  const { registration, client } = connection;
  const names: string[] = [];
  for (const tool of visibleTools(registration, connection.tools)) {
    const name = mcpToolName(registration.name, tool.name);
    names.push(name);
    pi.registerTool({
      name,
      label: `${registration.name}/${tool.name}`,
      description: describe(registration, tool),
      parameters: toolParameters(tool),
      async execute(_toolCallId, parameters, signal) {
        if (options.stillAllowed && !(await options.stillAllowed()))
          return failure("当前租约或授权代次已失效；请重新获取租约后再调用。");
        try {
          const args =
            parameters === null || typeof parameters !== "object" || Array.isArray(parameters)
              ? {}
              : (parameters as Record<string, unknown>);
          const result = await client.callTool(tool.name, args, signal ? { signal } : {});
          const details = {
            outcome: result.isError ? "failed" : "succeeded",
            server: registration.name,
            tool: tool.name,
            ...(result.structuredContent === undefined
              ? {}
              : { structuredContent: result.structuredContent }),
          };
          return {
            content: content(result, piMcp),
            details,
            ...(result.isError ? { isError: true } : {}),
          };
        } catch (error) {
          const details = {
            outcome: "unknown",
            server: registration.name,
            tool: tool.name,
            message: `远端 MCP 调用结果未知；操作可能已执行。不要自动重试有副作用的调用。${
              error instanceof Error ? `（${error.message}）` : ""
            }`,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(details) }],
            details,
            isError: true,
          };
        }
      },
    });
  }
  return names;
}
