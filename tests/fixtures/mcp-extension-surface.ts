/**
 * x3 夹具：MCP 工具结果在**真实 Pi 工具面**上的形状，以及工具目录变化的可见结论。
 *
 * 与 `mcp-extension-live.ts`（x2）的分工：x2 走真实 Sprout 中继（HTTP 网关 + 已认证
 * Worker exchange + 生产 dispatcher）；x3 只关心 Pi 那一侧的两件事，所以用真实 Pi 的
 * `McpClient` + `StdioTransport` 直连真实 `server-everything`，跑完就断言内容块与工具面。
 *
 * 两个受测行为：
 *   B1 图片不降级：真实 `get-tiny-image` 经 `registerMcpTools` + 真实 Pi 工具面执行后，
 *      `content` 里出现 `type:'image'`，base64 与 mimeType 原样，`structuredContent` 仍在
 *      `details`。
 *   B2 工具面可见性：新注册的 MCP 工具是否真的出现在 `getActiveToolNames()`（=声明给模型
 *      的工具）里，三种 allowlist 形状各测一次；结论写进 evidence，脚本按结论断言。
 *
 * 证据只写块类型、字节长度、工具名与数量：不写 base64 内容、不写工具输出正文。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { newId, ID_PREFIXES } from "../../src/contracts/ids";
import { loadPiMcp } from "../../src/extension/mcp-load";
import { registerMcpTools } from "../../src/extension/mcp-tools";
import { registerSproutMcp } from "../../src/extension/mcp-extension";
import type { SproutExtensionAPI } from "../../src/extension/types";
import type { PiMcpModule } from "../../src/extension/mcp-pi-types";

const evidencePath = process.env.X3_EVIDENCE ?? "/tmp/x3-mcp-extension-surface.json";
const directory = process.env.X3_DIR ?? mkdtempSync(join(tmpdir(), "x3-surface-"));
mkdirSync(directory, { recursive: true });
const pass = (name: string) => console.log(`PASS ${name}`);

const piMcp = await loadPiMcp();
// `loadPiMcp()` 只暴露本 extension 用到的三样；夹具另外需要真实 stdio 传输才能直连
// 真实 server（`src/extension/mcp-transport.ts` 是 Sprout 中继，由 x2 覆盖）。
const piMcpModule = (await import(pathToFileURL(join(piMcp.root, "dist/index.js")).href)) as {
  StdioTransport: new (options: { command: string; args: string[] }) => never;
};
const sdkRoot = join(piMcp.root, "..", "pi-coding-agent");
const sdk = (await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href)) as {
  createAgentSession: (options: Record<string, unknown>) => Promise<{
    session: {
      getActiveToolNames(): string[];
      getAllTools(): { name: string }[];
      getToolDefinition(name: string): {
        execute(
          toolCallId: string,
          params: unknown,
          signal: AbortSignal | undefined,
          onUpdate: unknown,
          ctx: unknown,
        ): Promise<{
          content: { type: string }[];
          details: Record<string, unknown>;
          isError?: boolean;
        }>;
      };
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
const sdkPackage = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")) as {
  version: string;
};
const work = join(directory, "cwd");
mkdirSync(join(work, "agent"), { recursive: true });

/** 真实 server-everything，真实 stdio 进程。 */
const client = new piMcp.McpClient({ name: "x3", version: "r1" });
await client.connect(
  new piMcpModule.StdioTransport({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything@2.0.1"],
  }),
);
const tools = await client.listTools();
assert(
  tools.some((tool) => tool.name === "get-tiny-image"),
  "真实 server 有 get-tiny-image",
);
assert(
  tools.some((tool) => tool.name === "get-structured-content"),
  "真实 server 有 get-structured-content",
);
pass(`真实 server-everything tools/list 返回 ${tools.length} 个工具`);

// ---------------------------------------------------------------- B1 图片不降级
const x3ProjectId = newId(ID_PREFIXES.project);
const x3MachineId = newId(ID_PREFIXES.machine);
const registration = {
  registrationId: newId(ID_PREFIXES.mcpRegistration),
  registrationRevision: 1,
  projectId: x3ProjectId,
  machineId: x3MachineId,
  name: "everything",
  transport: "stdio" as const,
  configHash: "a".repeat(64),
  exposure: "wire" as const,
  requestTimeoutMs: 120_000,
  roots: [],
  exposeSampling: false,
  elicitation: "absent" as const,
  processes: [],
};
const registered = new Map<string, Parameters<SproutExtensionAPI["registerTool"]>[0]>();
registerMcpTools({ registerTool: (tool) => registered.set(tool.name, tool) }, piMcp, {
  registration,
  transport: {} as never,
  client,
  // 两个真实工具：一个带图片，一个带 structuredContent。分开断言，不混在一个结果里。
  tools: tools.filter(
    (tool) => tool.name === "get-tiny-image" || tool.name === "get-structured-content",
  ),
  close: async () => undefined,
});

/**
 * 真实 Pi 工具面：把 extension 注册的工具交给真实 `AgentSession`，再由 session 侧取回
 * 工具定义执行——这样执行路径经过 Pi 的 schema 校验与结果包装，而不是直调 execute。
 */
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
      name: "x3-surface",
      factory: (pi: SproutExtensionAPI) => {
        for (const tool of registered.values()) pi.registerTool(tool);
      },
    },
  ],
});
await loader.reload();
assert.equal(loader.getExtensions().errors.length, 0, "真实 Pi 无扩展加载错误");

const toolName = "mcp__everything__get-tiny-image";
const session = await sdk.createAgentSession({
  cwd: work,
  agentDir: join(work, "agent"),
  resourceLoader: loader,
  settingsManager: sdk.SettingsManager.inMemory({}),
  sessionManager: sdk.SessionManager.inMemory(),
  // 与 `scripts/pi-host-runner.mjs` 一致：MCP 工具必须以 `mcp__*` 出现在 allowlist 里。
  tools: ["read", "bash", "mcp__*"],
});
// 断言它真的进了模型工具面，而不是只进了 registry。
assert(session.session.getActiveToolNames().includes(toolName), "真实 Pi 把该工具声明给了模型");
const definition = session.session.getToolDefinition(toolName);
assert(definition, "真实 Pi 的工具注册表里能取到该工具");
// 经过 Pi 持有的那份工具定义执行（与模型调用走同一个 execute）。
const result = await definition.execute("x3-image", {}, undefined, undefined, {} as never);

const imageBlock = result.content.find(
  (block): block is { type: "image"; data: string; mimeType: string } => block.type === "image",
);
assert(imageBlock, "get-tiny-image 的结果必须含 image 块");
assert.equal(imageBlock.mimeType, "image/png", "mimeType 原样");
assert(imageBlock.data.length > 100, "base64 内容非空");
// 逐字节对照真实 server 的返回值：证明没有被重新编码或截断。
const direct = await client.callTool("get-tiny-image", {});
const directImage = (direct.content ?? []).find((block) => block.type === "image") as
  | { data: string; mimeType: string }
  | undefined;
assert(directImage, "直接调用也有 image 块");
// 逐字节对照是真实比较的结果，evidence 读这个布尔，不写死。
const imageBase64MatchesServer = imageBlock.data === directImage.data;
assert(imageBase64MatchesServer, "base64 与真实 server 返回值逐字节相同");
pass(
  `真实 get-tiny-image 经工具面：块类型=${JSON.stringify(result.content.map((b) => b.type))}，` +
    `${imageBlock.mimeType} base64 ${imageBlock.data.length} 字节与 server 返回值一致`,
);
assert.equal(result.details.outcome, "succeeded");
// get-tiny-image 本身不带 structuredContent（真实 server 如此），照实断言它缺席，
// 不当成"图片把 structuredContent 吃了"。
assert.equal(
  result.details.structuredContent,
  undefined,
  "该工具本就没有 structuredContent，details 不应凭空造一个",
);

// structuredContent 用真实带它的工具断言：`get-structured-content` 回一份天气预报。
const structuredName = "mcp__everything__get-structured-content";
const structuredDefinition = session.session.getToolDefinition(structuredName);
assert(structuredDefinition, "真实 Pi registry 里有 get-structured-content");
const structuredResult = await structuredDefinition.execute(
  "x3-structured",
  { location: "Chicago" },
  undefined,
  undefined,
  {} as never,
);
const directStructured = await client.callTool("get-structured-content", { location: "Chicago" });
assert.equal(structuredResult.details.outcome, "succeeded");
assert(
  structuredResult.details.structuredContent !== undefined,
  "structuredContent 必须留在 details",
);
const structuredContentMatchesServer = isDeepStrictEqual(
  structuredResult.details.structuredContent,
  directStructured.structuredContent,
);
assert(structuredContentMatchesServer, "details.structuredContent 与真实 server 返回值一致");
pass(
  `structuredContent 仍在 details（键 ${Object.keys(structuredResult.details.structuredContent as object).join(",")}；与该工具 content 的文本块并存）`,
);
session.session.dispose();

// ---------------------------------------------------------------- B2 工具面可见性
const RUNNER_TOOLS = ["read", "bash", "edit", "write", "sprout_remote_file_read"];
const surfaceScenarios = [
  { label: "runner allowlist (no mcp__ entry)", extraTools: RUNNER_TOOLS },
  { label: "allowlist naming mcp__*", extraTools: [...RUNNER_TOOLS, "mcp__*"] },
  { label: "no tools option", extraTools: null },
];
const surface = [];
for (const scenario of surfaceScenarios) {
  const late: SproutExtensionAPI[] = [];
  const scopedLoader = new sdk.DefaultResourceLoader({
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
        name: "x3-scoped",
        factory: (pi: SproutExtensionAPI) => {
          // 只注册一个 mcp__ 工具，模拟 refresh() 装进来的第一批。
          pi.registerTool({
            name: "mcp__everything__echo",
            label: "everything/echo",
            description: "probe",
            parameters: { type: "object", properties: {} },
            async execute() {
              return { content: [{ type: "text", text: "ok" }], details: {} };
            },
          });
          late.push(pi);
        },
      },
    ],
  });
  await scopedLoader.reload();
  const options: Record<string, unknown> = {
    cwd: work,
    agentDir: join(work, "agent"),
    resourceLoader: scopedLoader,
    settingsManager: sdk.SettingsManager.inMemory({}),
    sessionManager: sdk.SessionManager.inMemory(),
  };
  if (scenario.extraTools) options.tools = scenario.extraTools;
  const created = await sdk.createAgentSession(options);
  const mcpActive = () =>
    created.session
      .getActiveToolNames()
      .filter((name) => name.startsWith("mcp__"))
      .sort();
  const before = mcpActive();
  // 运行期新增（= refresh() 重连后 registerTool 的时刻）。
  late[0]!.registerTool({
    name: "mcp__everything__added-1",
    label: "everything/added-1",
    description: "probe",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
  const after = mcpActive();
  surface.push({
    scenario: scenario.label,
    declaredBeforeLate: before,
    declaredAfterLate: after,
    lateToolDeclared: after.includes("mcp__everything__added-1"),
  });
  created.session.dispose();
}

// B2 结论必须与实测一致，不能写死成"能"或"不能"。
const blocked = surface.filter((entry) => !entry.lateToolDeclared);
const allowed = surface.filter((entry) => entry.lateToolDeclared);
assert(allowed.length > 0, "至少一种 allowlist 形状下新工具能进入模型工具面");
assert(
  blocked.length > 0,
  "runner 的精确名 allowlist 下新工具不进入模型工具面——这是根因，不是偶发",
);
const withoutRunnerAllowlist = surface.filter(
  (entry) => entry.scenario !== "runner allowlist (no mcp__ entry)",
);
assert(
  withoutRunnerAllowlist.every((entry) => entry.lateToolDeclared),
  "不被 allowlist 拦住时，运行期新增工具确实进入模型工具面",
);
pass(
  `工具面实测：${surface
    .map((entry) => `${entry.scenario}→${entry.lateToolDeclared ? "进入" : "未进入"}`)
    .join("；")}`,
);

// 生产 runner 必须把 `mcp__*` 放进 allowlist：没有这一条，上面测到的根因就会在真实
// `scripts/pi-host-runner.mjs` 里重现（新工具注册成功但到不了模型）。
//
// 只接受真实 sdk.createAgentSession 调用的对象实参中的直接数组字面量。
// 注释、字符串里的伪调用、其他属性和嵌套字符串都不能提供 allowlist 项。
const runnerSource = readFileSync(resolve("scripts/pi-host-runner.mjs"), "utf8");
const runnerAst = ts.createSourceFile(
  "pi-host-runner.mjs",
  runnerSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const runnerCalls: ts.CallExpression[] = [];
const visitRunner = (node: ts.Node): void => {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "sdk" &&
    node.expression.name.text === "createAgentSession"
  )
    runnerCalls.push(node);
  ts.forEachChild(node, visitRunner);
};
visitRunner(runnerAst);
assert.equal(runnerCalls.length, 1, "runner 必须有且仅有一个真实 sdk.createAgentSession 调用");
const runnerOptions = runnerCalls[0]!.arguments[0];
assert(
  runnerOptions && ts.isObjectLiteralExpression(runnerOptions),
  "runner session 实参必须为对象字面量",
);
const runnerTools = runnerOptions.properties.filter(
  (property): property is ts.PropertyAssignment =>
    ts.isPropertyAssignment(property) &&
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
    property.name.text === "tools",
);
assert.equal(runnerTools.length, 1, "runner session 必须有且仅有一个 tools 属性");
const runnerAllowlist = runnerTools[0]!.initializer;
assert(ts.isArrayLiteralExpression(runnerAllowlist), "runner tools 必须为数组字面量");
const runnerAllowlistHasMcpStar = runnerAllowlist.elements.some(
  (element) => ts.isStringLiteral(element) && element.text === "mcp__*",
);
assert(runnerAllowlistHasMcpStar, "runner 的真实 tools allowlist 必须含字符串字面量 mcp__*");
pass("生产 runner 的真实 sdk.createAgentSession tools 数组含 mcp__*（AST）");

// ---------------------------------------------------------------- refresh 的可见失败
// 真实验证「目录已变但工具面没跟进」被报成 failed 而不是 ok：这里用真实 MCP client，
// 但让 Pi 侧 allowlist 拦住 MCP 工具（runner 形状）。
const blockingLoader = new sdk.DefaultResourceLoader({
  cwd: work,
  agentDir: join(work, "agent"),
  settingsManager: sdk.SettingsManager.inMemory({}),
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  extensionFactories: [{ name: "x3-blocker", factory: () => undefined }],
});
await blockingLoader.reload();
const blockedSession = await sdk.createAgentSession({
  cwd: work,
  agentDir: join(work, "agent"),
  resourceLoader: blockingLoader,
  settingsManager: sdk.SettingsManager.inMemory({}),
  sessionManager: sdk.SessionManager.inMemory(),
  tools: RUNNER_TOOLS,
});

// 用一个只回一条登记的假目录，工具面核对走真实 Pi `getActiveTools`。
//
// 传输替换点：`registerSproutMcp` 总是构造 Sprout 中继 transport，而这里没有 Sprout 服务端
// （那是 x2 的范围）。所以注入一个 `McpClient`，它把 `connect()` 落到真实 stdio 上——
// MCP 协议、真实 server、真实 Pi 工具面都是真的，只有帧从哪条管道过是替换的。
/** 一个只把 connect() 换成真实 stdio 的 McpClient 子类。 */
class StdioMcpClient extends piMcp.McpClient {
  override async connect(): Promise<unknown> {
    return super.connect(
      new piMcpModule.StdioTransport({
        command: process.execPath,
        args: [resolve("tests/fixtures/mcp-surface-server.mjs")],
      }) as never,
    );
  }
}
const stdioClient = StdioMcpClient as unknown as PiMcpModule["McpClient"];

const events = new Map<string, () => void | Promise<void>>();
let registeredNames: string[] = [];
const surfaced = await registerSproutMcp(
  {
    registerTool(tool: { name: string }) {
      registeredNames.push(tool.name);
    },
    getActiveTools: () => blockedSession.session.getActiveToolNames(),
    on(event: string, handler: () => void | Promise<void>) {
      events.set(event, handler);
    },
  } as never,
  {
    piMcp: { ...piMcp, McpClient: stdioClient },
    remote: {
      projectId: x3ProjectId,
      async request() {
        return {
          outcome: "response" as const,
          result: {
            ok: true as const,
            data: {
              registrations: [
                {
                  ...registration,
                  processes: [
                    {
                      processId: newId(ID_PREFIXES.mcpProcess),
                      workerIncarnationId: randomUUID(),
                      lastObservedAt: Date.now(),
                    },
                  ],
                },
              ],
            },
            requestId: newId(ID_PREFIXES.request),
          },
        };
      },
    },
    machineId: x3MachineId,
    authorizationGeneration: () => 1,
  },
);
const refreshed = await surfaced.refresh();
assert.equal(refreshed.outcome, "failed", "工具面没跟进时必须报 failed，不是 ok");
assert(
  refreshed.outcome === "failed" && refreshed.error.message.includes("未进入模型工具面"),
  `失败原因要指名工具面：${refreshed.outcome === "failed" ? refreshed.error.message : ""}`,
);
assert(surfaced.lastError, "诊断槽必须留住这条失败（sprout_status 读它）");
pass(
  `refresh() 在真实 Pi 的 runner allowlist 下报 failed（${registeredNames.length} 个工具已注册但未声明给模型），诊断非空`,
);
blockedSession.session.dispose();

// ---------------------------------------------------------------- list_changed 真的到达模型工具面
// 正面证据：真实 server 改目录（add-tool 真的往 tools/list 里加一条并发
// notifications/tools/list_changed），refresh() 复用连接、重列、注册，最终
// 新工具出现在 Pi 的 `getActiveToolNames()` 里并可被调用。
// 固定 process identity：refresh() 靠它判断能不能复用连接。每次换 id 会让
// refresh() 正确地丢弃旧连接——那是另一个测试的事，不是这一场要测的。
const positiveProcessId = newId(ID_PREFIXES.mcpProcess);
const positiveIncarnationId = randomUUID();
let positiveExtension: Awaited<ReturnType<typeof registerSproutMcp>> | null = null;
const positiveLoader = new sdk.DefaultResourceLoader({
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
      name: "x3-positive",
      factory: async (pi: SproutExtensionAPI & { on: never }) => {
        positiveExtension = await registerSproutMcp(pi, {
          piMcp: { ...piMcp, McpClient: stdioClient },
          remote: {
            projectId: x3ProjectId,
            async request() {
              return {
                outcome: "response" as const,
                result: {
                  ok: true as const,
                  data: {
                    registrations: [
                      {
                        ...registration,
                        processes: [
                          {
                            processId: positiveProcessId,
                            workerIncarnationId: positiveIncarnationId,
                            lastObservedAt: Date.now(),
                          },
                        ],
                      },
                    ],
                  },
                  requestId: newId(ID_PREFIXES.request),
                },
              };
            },
          },
          machineId: x3MachineId,
          authorizationGeneration: () => 1,
        });
      },
    },
  ],
});
await positiveLoader.reload();
assert.equal(positiveLoader.getExtensions().errors.length, 0);
const positiveSession = await sdk.createAgentSession({
  cwd: work,
  agentDir: join(work, "agent"),
  resourceLoader: positiveLoader,
  settingsManager: sdk.SettingsManager.inMemory({}),
  sessionManager: sdk.SessionManager.inMemory(),
  // 修复后的 runner 形状：allowlist 里带 `mcp__*`。
  tools: [...RUNNER_TOOLS, "mcp__*"],
});
const first = await positiveExtension!.refresh();
assert.equal(first.outcome, "ok", `修复后 refresh 必须 ok：${first.outcome}`);
const declaredBefore = positiveSession.session
  .getActiveToolNames()
  .filter((name) => name.startsWith("mcp__"))
  .sort();
assert(!declaredBefore.includes("mcp__everything__added-1"), "改动前没有 added-1");

// 真实目录变化：server 侧真的加工具并发 list_changed。
const addToolDefinition = positiveSession.session.getToolDefinition("mcp__everything__add-tool");
assert(addToolDefinition, "add-tool 在 registry 里");
await addToolDefinition.execute("x3-add", {}, undefined, undefined, {} as never);
// 等真实 stdio 往返 + 订阅回调重列。
let waited = 0;
while (
  !positiveSession.session.getActiveToolNames().includes("mcp__everything__added-1") &&
  waited < 8000
) {
  await new Promise((done) => setTimeout(done, 50));
  waited += 50;
}
const declaredAfter = positiveSession.session
  .getActiveToolNames()
  .filter((name) => name.startsWith("mcp__"))
  .sort();
assert(
  declaredAfter.includes("mcp__everything__added-1"),
  `list_changed 后新工具必须进入模型工具面，实测：${declaredAfter.join(", ")}`,
);
// 再显式 refresh 一次：连接复用，新工具不会丢。
const second = await positiveExtension!.refresh();
assert.equal(second.outcome, "ok");
const declaredAfterRefresh = positiveSession.session
  .getActiveToolNames()
  .filter((name) => name.startsWith("mcp__"))
  .sort();
assert(declaredAfterRefresh.includes("mcp__everything__added-1"));
// 模型工具面里取得到 definition 才叫能调用；真调一次拿内容。
const addedDefinition = positiveSession.session.getToolDefinition("mcp__everything__added-1");
assert(addedDefinition, "新工具在 registry 里可调用");
const called = await addedDefinition.execute("x3-call", {}, undefined, undefined, {} as never);
// 「能调用」= 这一次真实调用真的回到了 server 并拿到它回的文本。布尔从返回值算出。
const calledTexts = called.content.map((block) => (block as { text?: string }).text ?? null);
const callReturned = called.content.length > 0;
const callTextMatchesServer = calledTexts.length === 1 && calledTexts[0] === "called:added-1";
assert(
  callTextMatchesServer,
  `新工具真的被执行到了 server，实测 content 文本：${JSON.stringify(calledTexts)}`,
);
pass(
  `真实 list_changed → refresh(复用连接) → 模型工具面：${declaredBefore.length}→${declaredAfter.length} 个 mcp__ 工具，added-1 可见且调用返回 ${JSON.stringify((called.content[0] as { text?: string }).text)}`,
);
positiveSession.session.dispose();
await positiveExtension!.close();

await client.close();

const evidence = {
  sdkVersion: sdkPackage.version,
  realServerToolCount: tools.length,
  image: {
    blockTypes: result.content.map((block) => block.type),
    mimeType: imageBlock.mimeType,
    base64Length: imageBlock.data.length,
    matchesServerBytes: imageBase64MatchesServer,
    structuredContentInDetails: structuredResult.details.structuredContent ?? null,
    structuredContentMatchesServer,
  },
  surface,
  runnerAllowlistHasMcpStar,
  listChanged: {
    declaredBefore: declaredBefore.length,
    declaredAfter: declaredAfter.length,
    newToolDeclared: declaredAfter.includes("mcp__everything__added-1"),
    newToolCallable: callReturned && callTextMatchesServer,
    callReturned,
    callTextMatchesServer,
    callText: calledTexts[0] ?? null,
    stillDeclaredAfterExplicitRefresh: declaredAfterRefresh.includes("mcp__everything__added-1"),
  },
  refreshOnBlockedSurface: {
    outcome: refreshed.outcome,
    registeredNotDeclared: registeredNames.length,
    diagnosticPresent: surfaced.lastError !== null,
  },
  scope:
    "Real Pi AgentSession + real @modelcontextprotocol/server-everything@2.0.1 over stdio. Sprout relay transport is covered by x2.",
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(`DONE x3 mcp extension surface (evidence ${evidencePath})`);
process.exit(0);
