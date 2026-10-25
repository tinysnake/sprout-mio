import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpContentBlock, McpTool, PiMcpModule } from "./mcp-pi-types";

/**
 * 定位托管 Pi 安装目录，逻辑与 `scripts/pi-host-runner.mjs` 的 `sdkRoot()` 同款：
 * 先跟着 `bin/pi` 的真实路径向上找 `@earendil-works/pi-coding-agent`，再退回
 * `install/releases/<version>/node_modules/...`（版本号降序取第一个装好的）。
 */
function sdkRoot(agentDir: string): string {
  const releases = join(agentDir, "install", "releases");
  const candidates: string[] = [];
  try {
    const executable = realpathSync(join(agentDir, "bin", "pi"));
    let current = dirname(executable);
    while (current !== dirname(current)) {
      if (existsSync(join(current, "package.json"))) {
        const pkg = JSON.parse(readFileSync(join(current, "package.json"), "utf8")) as {
          name?: string;
        };
        if (pkg.name === "@earendil-works/pi-coding-agent") candidates.push(current);
      }
      current = dirname(current);
    }
  } catch {
    // `bin/pi` 不是本机安装入口时退回 releases 目录扫描。
  }
  if (existsSync(releases)) {
    const versions = readdirSync(releases).filter((value) =>
      /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value),
    );
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions)
      candidates.push(
        join(releases, version, "node_modules", "@earendil-works", "pi-coding-agent"),
      );
  }
  const root = candidates.find((path) => existsSync(join(path, "dist", "index.js")));
  if (!root) throw new Error("找不到 Pi SDK，请在 PI_CODING_AGENT_DIR 对应目录安装托管 Pi");
  return root;
}

export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function piMcpRoot(agentDir = piAgentDir()): string {
  // `pi-mcp` 与 `pi-coding-agent` 是同一个 node_modules 下的同级包。
  const root = join(dirname(sdkRoot(agentDir)), "pi-mcp");
  if (!existsSync(join(root, "dist", "index.js")))
    throw new Error("找不到 Pi MCP 客户端，请在 PI_CODING_AGENT_DIR 对应目录安装托管 Pi");
  return root;
}

/**
 * 运行时深导入托管的 `@earendil-works/pi-mcp`。
 *
 * 仓库根 `package.json` 没有 `@earendil-works/*` 依赖，`tsconfig.extension.json` 也只编译
 * `src/extension/**`，所以这里沿用 `pi-host-runner.mjs:19-58` 的做法：运行时按托管安装目录
 * 解析并动态 `import()`，绝不为它新增 npm 依赖。解析或导出缺失一律显式报错，不静默降级成
 * 「不支持的半实现」。
 */
export async function loadPiMcp(agentDir = piAgentDir()): Promise<PiMcpModule> {
  const root = piMcpRoot(agentDir);
  const url = pathToFileURL(join(root, "dist", "index.js")).href;
  let module: Record<string, unknown>;
  try {
    module = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Pi MCP 客户端加载失败（${url}）：${error instanceof Error ? error.message : "未知错误"}`,
    );
  }
  const exportNames = Object.keys(module).sort();
  const McpClient = module.McpClient;
  const parseJsonRpcMessage = module.parseJsonRpcMessage;
  const toLlmContent = module.toLlmContent;
  if (typeof McpClient !== "function" || typeof parseJsonRpcMessage !== "function")
    throw new Error(
      `Pi MCP 客户端导出缺失：需要 McpClient 与 parseJsonRpcMessage，实测导出 ${exportNames.join(", ")}`,
    );
  return {
    McpClient: McpClient as PiMcpModule["McpClient"],
    parseJsonRpcMessage: parseJsonRpcMessage as PiMcpModule["parseJsonRpcMessage"],
    // 1.4.0 里 toLlmContent 与客户端同包导出；缺失时退回只保留文本块，不冒充结构化内容。
    toLlmContent:
      typeof toLlmContent === "function"
        ? (toLlmContent as (result: unknown) => McpContentBlock[])
        : (result) => {
            const content = (result as { content?: McpContentBlock[] }).content ?? [];
            return content.filter((block) => block.type === "text");
          },
    root,
    exportNames,
  };
}

/** 工具输入 schema 直接沿用远端 server 的 JSON Schema，补上闭合对象约束。 */
export function toolParameters(tool: Pick<McpTool, "inputSchema">): Record<string, unknown> {
  const schema = tool.inputSchema;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema))
    return { type: "object", properties: {}, additionalProperties: false };
  return { ...(schema as Record<string, unknown>) };
}
