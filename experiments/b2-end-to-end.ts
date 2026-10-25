/**
 * B2 的端到端实测：真实 MCP server 真的改了目录，Pi 的模型工具面是否跟上。
 *
 * 这是 `experiments/b2-rootcause.mjs` 的端到端版本：那边只测 Pi 的注册/激活规则，
 * 这边跑完整条链——真实 server（`tests/fixtures/mcp-surface-server.mjs`，官方 SDK，
 * 不 mock 协议）→ `notifications/tools/list_changed` → `registerSproutMcp().refresh()`
 * → 真实 Pi `AgentSession`。
 *
 * 三种 session 形状各测一次，因为 B2 的根因就在 `createAgentSession({ tools })`：
 *   - runner 的精确名 allowlist（修复前）：新工具注册成功但到不了模型；
 *   - runner 的 allowlist + `mcp__*`（修复后）：新工具进入模型工具面并可被调用；
 *   - 不传 tools：同样进入。
 *
 * 用法：node experiments/b2-end-to-end.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPiMcp } from "../src/extension/mcp-load";

const piMcp = await loadPiMcp();
const piMcpModule = (await import(pathToFileURL(join(piMcp.root, "dist/index.js")).href)) as {
  StdioTransport: new (options: { command: string; args: string[] }) => never;
};
const sdkRoot = join(piMcp.root, "..", "pi-coding-agent");
const sdk = (await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href)) as never as {
  createAgentSession: (options: Record<string, unknown>) => Promise<{
    session: {
      getActiveToolNames(): string[];
      getToolDefinition(name: string):
        | {
            execute(
              toolCallId: string,
              params: unknown,
              signal: undefined,
              onUpdate: undefined,
              ctx: unknown,
            ): Promise<{ content: { type: string }[]; details: Record<string, unknown> }>;
          }
        | undefined;
      dispose(): void;
    };
  }>;
  DefaultResourceLoader: new (options: Record<string, unknown>) => {
    reload(): Promise<void>;
    getExtensions(): { errors: unknown[] };
  };
  SettingsManager: { inMemory(snapshot: Record<string, unknown>): unknown };
  SessionManager: { inMemory(): unknown };
};
const { registerSproutMcp } = await import("../src/extension/mcp-extension");
const { registerMcpTools } = await import("../src/extension/mcp-tools");

const work = mkdtempSync(join(tmpdir(), "sprout-b2-e2e-"));
mkdirSync(join(work, "agent"), { recursive: true });
const serverPath = resolve("tests/fixtures/mcp-surface-server.mjs");

/**
 * 每个 scene 一条真实 server 连接。
 *
 * `registerSproutMcp` 固定构造 Sprout 中继 transport（Sprout 服务端由 x2 覆盖），所以这里
 * 注入一个只把 `connect()` 换成本地 stdio 的 `McpClient` 子类：MCP 协议、真实 server
 * 进程、真实 Pi 工具面都是真的，只有帧从哪条管道过是替换的。
 */
class LocalStdioClient extends piMcp.McpClient {
  override async connect(): Promise<unknown> {
    return super.connect(
      new piMcpModule.StdioTransport({
        command: process.execPath,
        args: [serverPath],
      }) as never,
    );
  }
}

const registration = {
  registrationId: "mcp_00000000-0000-4000-8000-000000000001",
  registrationRevision: 1,
  projectId: "prj_00000000-0000-4000-8000-000000000000",
  machineId: "mch_00000000-0000-4000-8000-000000000000",
  name: "surface",
  transport: "stdio" as const,
  configHash: "a".repeat(64),
  exposure: "wire" as const,
  requestTimeoutMs: 30_000,
  roots: [],
  exposeSampling: false,
  elicitation: "absent" as const,
  processes: [
    {
      processId: "mpr_00000000-0000-4000-8000-000000000002",
      workerIncarnationId: "00000000-0000-4000-8000-000000000003",
      lastObservedAt: 0,
    },
  ],
};

async function scene({ label, tools }) {
  const events = new Map<string, () => void | Promise<void>>();
  let extension = null;
  const loader = new sdk.DefaultResourceLoader({
    cwd: work,
    agentDir: join(work, "agent"),
    settingsManager: sdk.SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      {
        name: "b2-e2e",
        factory: async (pi: never) => {
          extension = await registerSproutMcp(pi, {
            remote: {
              projectId: registration.projectId,
              async request() {
                return {
                  outcome: "response" as const,
                  result: {
                    ok: true as const,
                    data: { registrations: [registration] },
                    requestId: "req_00000000-0000-4000-8000-000000000004",
                  },
                };
              },
            },
            machineId: registration.machineId,
            authorizationGeneration: () => 1,
            piMcp: { ...piMcp, McpClient: LocalStdioClient as unknown as typeof piMcp.McpClient },
          });
        },
      },
    ],
  });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0, `${label}: 无扩展加载错误`);
  const options: Record<string, unknown> = {
    cwd: work,
    agentDir: join(work, "agent"),
    resourceLoader: loader,
    settingsManager: sdk.SettingsManager.inMemory({}),
    sessionManager: sdk.SessionManager.inMemory(),
  };
  if (tools) options.tools = tools;
  const { session } = await sdk.createAgentSession(options);

  // 修复后 refresh() 复用连接，所以这里先 refresh 建连，再触发真实的目录变化。
  const first = await extension.refresh();
  const declaredInitial = session.getActiveToolNames().filter((n) => n.startsWith("mcp__")).sort();

  // 真实目录变化：调用 server 的 add-tool，它真的往 tools/list 里加一条并发 list_changed。
  const addTool = session.getToolDefinition("mcp__surface__add-tool");
  assert(addTool, `${label}: add-tool 应在 registry 里`);
  await addTool.execute("e2e-add", {}, undefined, undefined, {} as never);
  // 等通知到达 Pi 的 MCP 客户端并完成重列（真实 stdio 往返）。
  await new Promise((done) => setTimeout(done, 900));

  // 路径 A（不调 refresh）：只靠 list_changed 订阅。
  const declaredViaNotification = session
    .getActiveToolNames()
    .filter((n) => n.startsWith("mcp__"))
    .sort();
  const toolsViaNotification = [...extension.tools];

  // 路径 B：显式 refresh() 再对齐一次。
  const second = await extension.refresh();
  const declaredAfter = session
    .getActiveToolNames()
    .filter((n) => n.startsWith("mcp__"))
    .sort();
  const toolsAfterRefresh = [...extension.tools];

  // 新工具能不能真的被调用（模型工具面里能取到 definition 才叫能调用）。
  const addedDefinition = session.getToolDefinition("mcp__surface__added-1");
  const callResult = addedDefinition
    ? await addedDefinition.execute("e2e-call", {}, undefined, undefined, {} as never)
    : null;

  session.dispose();
  await extension.close();
  return {
    label,
    firstRefresh: first.outcome,
    secondRefresh: second.outcome,
    refreshError: second.outcome === "failed" ? second.error.message : null,
    declaredInitial,
    // 路径 A：list_changed 订阅单独把它带进模型工具面。
    newToolDeclaredViaListChanged: declaredViaNotification.includes("mcp__surface__added-1"),
    toolsViaNotification,
    // 路径 B：显式 refresh 之后仍在。
    declaredAfter,
    newToolDeclaredAfterRefresh: declaredAfter.includes("mcp__surface__added-1"),
    toolsAfterRefresh,
    newToolCallable: addedDefinition !== undefined,
    callContent: callResult
      ? callResult.content.map((block) => (block as { text?: string }).text ?? block.type)
      : null,
  };
}

const RUNNER_TOOLS = ["read", "bash", "edit", "write", "sprout_remote_file_read"];
const results = [];
results.push(await scene({ label: "修复前 runner allowlist（精确名，无 mcp__）", tools: RUNNER_TOOLS }));
results.push(
  await scene({ label: "修复后 runner allowlist（含 mcp__*）", tools: [...RUNNER_TOOLS, "mcp__*"] }),
);
results.push(await scene({ label: "不传 tools", tools: null }));

writeFileSync(
  join(work, "evidence.json"),
  `${JSON.stringify({ work, results }, null, 2)}\n`,
);
console.log(JSON.stringify({ work, results }, null, 2));
process.exit(0);
