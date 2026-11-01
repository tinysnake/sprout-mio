/**
 * B2 根因实测夹具（不参与 verify 门禁，供报告引用）。
 *
 * 症状：server 发出 `notifications/tools/list_changed` 后，Pi 的模型工具面
 * （`getActiveToolNames()`，即"声明给模型的工具"）里没有新工具。
 *
 * 本夹具把三层拆开分别实测：
 *   1. Pi 扩展 `registerTool` 在**运行期**（`bindExtensions` 之后）是否被接受并进入 registry；
 *   2. 进入 registry 的工具是否进入 active set（= 声明给模型）；
 *   3. active set 是否受 `createAgentSession({ tools })` 的 allowlist 约束。
 *
 * 三种 session 构造方式并排跑，因为 Sprout 的 `scripts/pi-host-runner.mjs:221` 用的是
 * 精确名字 allowlist（`["read","bash","edit","write", ...remote]`，不含任何 `mcp__` 条目）。
 *
 * 用法：node experiments/b2-rootcause.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SDK_ROOT =
  "/Users/snake/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent";
const sdk = await import(pathToFileURL(join(SDK_ROOT, "dist/index.js")).href);
const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager } = sdk;

const work = mkdtempSync(join(tmpdir(), "sprout-b2-rootcause-"));
mkdirSync(join(work, "agent"), { recursive: true });

const tool = (name) => ({
  name,
  label: name,
  description: `probe ${name}`,
  parameters: { type: "object", properties: {} },
  async execute() {
    return { content: [{ type: "text", text: name }], details: {} };
  },
});

/** Sprout runner 的真实 allowlist 形状（`scripts/pi-host-runner.mjs:221`）。 */
const RUNNER_TOOLS = ["read", "bash", "edit", "write", "sprout_remote_file_read"];

const scenarios = [
  { label: "runner allowlist (exact names, no mcp__)", options: { tools: RUNNER_TOOLS } },
  { label: "allowlist naming mcp__*", options: { tools: [...RUNNER_TOOLS, "mcp__*"] } },
  { label: "no tools option (includeAllExtensionTools)", options: {} },
];

const results = [];
for (const scenario of scenarios) {
  // 每次重新建 loader：一个 extension API 实例绑定一条 session，session.dispose() 后
  // 那个实例会 invalidate，不能跨 session 复用（Pi 的 stale-ctx 保护）。
  let registerLate = null;
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
        name: "b2-probe",
        factory: (pi) => {
          pi.registerTool(tool("mcp__pireg__echo"));
          registerLate = (name) => pi.registerTool(tool(name));
        },
      },
    ],
  });
  await loader.reload();
  const loaderErrors = loader.getExtensions().errors.length;
  const { session } = await createAgentSession({
    cwd: work,
    agentDir: join(work, "agent"),
    resourceLoader: loader,
    settingsManager: SettingsManager.inMemory({}),
    sessionManager: SessionManager.inMemory(),
    ...scenario.options,
  });
  const mcp = (names) => names.filter((n) => n.startsWith("mcp__")).sort();
  const registeredAfterStart = mcp(
    session
      .getAllTools()
      .map((t) => t.name),
  );
  const activeAfterStart = mcp(session.getActiveToolNames());
  // 运行期新增工具：这就是 refresh() 重连后 registerTool 的时刻。
  registerLate("mcp__pireg__added-1");
  const registeredAfterLate = mcp(
    session
      .getAllTools()
      .map((t) => t.name),
  );
  const activeAfterLate = mcp(session.getActiveToolNames());
  results.push({
    scenario: scenario.label,
    loaderErrors,
    registeredAfterStart,
    activeAfterStart,
    registeredAfterLate,
    activeAfterLate,
    earlyToolRegistered: registeredAfterStart.includes("mcp__pireg__echo"),
    earlyToolDeclaredToModel: activeAfterStart.includes("mcp__pireg__echo"),
    lateToolRegistered: registeredAfterLate.includes("mcp__pireg__added-1"),
    lateToolDeclaredToModel: activeAfterLate.includes("mcp__pireg__added-1"),
  });
  session.dispose();
}

const out = { sdkRoot: SDK_ROOT, work, results };
writeFileSync(join(work, "evidence.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
process.exit(0);
