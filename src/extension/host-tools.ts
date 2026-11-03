import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 宿主只读工具面。
 *
 * 这里只列工具名，不负责注册。runner 用它构造 allowlist，测试用它守住
 * 「没有租约也不能出现 host bash/edit/write」这条边界。
 */
export const HOST_CORE_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "current_time",
  "git_read",
  "codemode",
  "tool_search",
] as const;

/** pi-web-access 默认注册的工具名。扩展缺席时这些名字不能进 allowlist。 */
export const HOST_WEB_TOOLS = [
  "web_search",
  "fetch_content",
  "source_check",
  "get_search_content",
] as const;

export type HostCoreTool = (typeof HOST_CORE_TOOLS)[number];
export type HostWebTool = (typeof HOST_WEB_TOOLS)[number];

/**
 * 找到宿主已安装的 pi-web-access 扩展入口。
 *
 * 优先显式环境变量；否则按宿主 Pi 的 npm 目录、再到 ~/.pi/agent 的 npm 目录。
 * 返回 null 表示这台机器没有安装，runner 不应把 web 工具名放进 allowlist。
 */
export function resolveWebAccessExtension(
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env.SPROUT_PI_WEB_ACCESS_PATH?.trim();
  if (explicit) {
    const entry = join(explicit, "dist", "index.js");
    return existsSync(entry) ? entry : existsSync(explicit) ? explicit : null;
  }
  const candidates = [
    join(agentDir, "npm", "node_modules", "pi-web-access", "dist", "index.js"),
    join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-web-access", "dist", "index.js"),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** allowlist 的实际组合；web 扩展缺席时不会留下永远注册不上的工具名。 */
export function hostToolNames(webAccessEntry: string | null): string[] {
  return [...HOST_CORE_TOOLS, ...(webAccessEntry ? HOST_WEB_TOOLS : [])];
}
