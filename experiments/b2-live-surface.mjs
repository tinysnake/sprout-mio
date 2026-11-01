/**
 * B2 第二层实测：真实 `server-everything` + 真实 Pi `AgentSession`，测「注册成功」之后
 * 新工具是否真的进入**模型工具面**（`getActiveToolNames()`，即声明给模型的工具）。
 *
 * 与 `experiments/b2-rootcause.mjs` 的区别：那个只测 Pi 的注册/激活规则；这个把 MCP 侧
 * 换成真实 server（`npx @modelcontextprotocol/server-everything@2.0.1`），走 Pi 原生
 * `McpClient` + `StdioTransport`（不经 Sprout 中继，中继层由 x2 覆盖），因此能把
 * 「MCP 目录真的变了」与「Pi 工具面是否跟着变」分开。
 *
 * 用法：node experiments/b2-live-surface.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SDK_ROOT =
  "/Users/snake/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent";
const MCP_ROOT = "/Users/snake/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-mcp";
const sdk = await import(pathToFileURL(join(SDK_ROOT, "dist/index.js")).href);
const piMcp = await import(pathToFileURL(join(MCP_ROOT, "dist/index.js")).href);
const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager } = sdk;

const work = mkdtempSync(join(tmpdir(), "sprout-b2-live-"));
mkdirSync(join(work, "agent"), { recursive: true });

// 直接内联同一命名规则，避免在裸 Node 里解析 .ts 的无扩展名相对导入。
const mcpToolName = (serverName, toolName) => `mcp__${serverName}__${toolName}`;

/** Sprout runner 的真实 allowlist 形状（`scripts/pi-host-runner.mjs:221`）。 */
const RUNNER_TOOLS = ["read", "bash", "edit", "write", "sprout_remote_file_read"];

async function scenario({ label, sessionOptions, exposure }) {
  const client = new piMcp.McpClient({ name: "b2-live", version: "r1" });
  await client.connect(
    new piMcp.StdioTransport({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything@2.0.1"],
    }),
  );
  const registered = [];
  let changed = 0;
  client.onNotification("notifications/tools/list_changed", () => {
    changed += 1;
  });

  let refresh = null;
  const loader = new DefaultResourceLoader({
    cwd: work,
    agentDir: join(work, "agent"),
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      {
        name: "b2-live",
        factory: (pi) => {
          // 与 registerMcpTools 一致的注册形状，只多一个 exposure 变量用于对照。
          refresh = async () => {
            const tools = await client.listTools();
            for (const tool of tools) {
              const name = mcpToolName("everything", tool.name);
              if (registered.some((entry) => entry.name === name)) continue;
              registered.push({ name, tool });
              pi.registerTool({
                name,
                label: `everything/${tool.name}`,
                description: tool.description ?? tool.name,
                parameters: { type: "object", properties: {} },
                ...(exposure ? { exposure } : {}),
                async execute() {
                  return { content: [{ type: "text", text: "ok" }], details: {} };
                },
              });
            }
          };
        },
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: work,
    agentDir: join(work, "agent"),
    resourceLoader: loader,
    settingsManager: SettingsManager.inMemory({}),
    sessionManager: SessionManager.inMemory(),
    ...sessionOptions,
  });
  await refresh();
  const activeAfterInitial = session.getActiveToolNames().filter((n) => n.startsWith("mcp__")).sort();
  const registeredAfterInitial = registered.map((e) => e.name).sort();

  // 真实目录变化：server 侧发 notifications/tools/list_changed，再重新 tools/list。
  const index = new Map(registered.map((entry) => [entry.tool.name, entry]));
  const trigger = index.get("trigger-list-changed");
  if (trigger) {
    // server-everything 的 trigger-list-changed 只发通知，不改目录；这里用它的通知
    // 验证「通知到达」与「工具面是否变化」是两回事。
    await client.callTool("trigger-list-changed", { list: "tools" });
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  const activeAfterNotification = session
    .getActiveToolNames()
    .filter((n) => n.startsWith("mcp__"))
    .sort();
  await refresh();
  const activeAfterRefresh = session.getActiveToolNames().filter((n) => n.startsWith("mcp__")).sort();
  const registeredAfterRefresh = registered.map((e) => e.name).sort();

  const out = {
    scenario: label,
    exposure: exposure ?? "default (direct)",
    listChangedNotificationsReceived: changed,
    registeredAfterInitial: registeredAfterInitial.length,
    activeAfterInitial: activeAfterInitial.length,
    toolSearchRegistered: session.getAllTools().some((t) => t.name === "tool_search"),
    // 「注册成功」与「声明给模型」是两个不同的量：
    registeredNotDeclared: registeredAfterRefresh.filter((n) => !activeAfterRefresh.includes(n)),
    activeAfterNotification: activeAfterNotification.length,
    activeAfterRefresh: activeAfterRefresh.length,
    sampleActive: activeAfterRefresh.slice(0, 3),
    sampleDeclared: activeAfterRefresh.slice(0, 3),
    registeredAfterRefresh: registeredAfterRefresh.length,
  };
  session.dispose();
  await client.close();
  return out;
}

const results = [];
results.push(
  await scenario({
    label: "runner allowlist (exact names, no mcp__)",
    sessionOptions: { tools: RUNNER_TOOLS },
  }),
);
results.push(
  await scenario({
    label: "runner allowlist + mcp__* entry",
    sessionOptions: { tools: [...RUNNER_TOOLS, "mcp__*"] },
  }),
);
results.push(
  await scenario({ label: "no tools option (includeAllExtensionTools)", sessionOptions: {} }),
);

writeFileSync(join(work, "evidence.json"), `${JSON.stringify({ work, results }, null, 2)}\n`);
console.log(JSON.stringify({ work, results }, null, 2));
process.exit(0);
