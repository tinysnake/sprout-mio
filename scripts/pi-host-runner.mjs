import { createHash } from "node:crypto";
import { promptWithTurnContext } from "./pi-host-turn-context.mjs";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createPiModelRuntime } from "./pi-model-runtime.mjs";
import { jsonFile } from "./pi-host-skills.mjs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

let memoryConfigDir;
function clearMemoryEnvironment() {
  for (const name of Object.keys(process.env))
    if (name.startsWith("HINDSIGHT_")) delete process.env[name];
}
function cleanupMemory() {
  clearMemoryEnvironment();
  if (memoryConfigDir) rmSync(memoryConfigDir, { recursive: true, force: true });
  memoryConfigDir = undefined;
}
clearMemoryEnvironment();
process.once("exit", cleanupMemory);

const input = createInterface({ input: process.stdin });
const line = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
let session;
let opening = false;
let prompting = false;
let closing = false;
let openId = "unknown";
let turnContextPromptInputSchema;
let assistantInputContextSchema;
let assistantMode = false;
let infoHubHintSchema;
const submittedContexts = new Set();

/** 个人助理的表达约定，只有 assistant 职责挂。 */
const ASSISTANT_GUIDE = `

面向 Human 的表达应简短自然。先说结论、进展或需要对方决定的事。使用 Project、Agent、对话的名称，不向 Human 罗列内部 ID、工具响应字段或活动日志。不要重复整份提案或转发原始数据。提案 body 只写交给工作 Agent 的具体工作要求，避免附加传话背景、成员 ID 和其他无关信息。确实需要排查时再提供细节。区分已提交、正在处理、已回复与结果未经验证，不把运行结束称作业务成功。

频道关注由程序按 Human 授权的 interval 时间窗口合并消息和工作活动，不是每次 run 结束立即转发。Human 要求停止关注时，调用 sprout_assistant_watch，传当前目标的 targetProjectId、chatId 和 active:false；你能停止本 DM 的关注，无需再次确认。看到 action:stopped、active:false 后明确告知已停止汇报；这不会取消正在执行的工作。不要声称工具不能取消，不要用 intervalSeconds:0。重新关注必须提出新请求并由 Human 确认。`;

/** 消息里的 HTML 代码块会进沙箱，这段说清沙箱里有什么、没什么。 */
const HTML_ARTIFACT_GUIDE = `

消息里的 HTML 代码块会在沙箱里渲染成页面，用来交付图表、原型和报告。页面拿不到应用的样式和网络，不要在文档里引用外部图片、字体或 CDN，图片用 data URI，脚本内联。颜色用主题变量，深色主题会自动换成对应的值，写死颜色在深色下会失真。常用变量有 --background、--foreground、--muted、--muted-foreground、--border、--border-soft、--card、--card-foreground、--primary、--primary-foreground、--secondary、--accent、--accent-foreground、--destructive、--status-success、--status-warning、--status-failed、--chart-1 到 --chart-5、--radius、--font-body、--font-display、--font-sans、--font-mono。页面高度随内容自适应并回填到消息里，不要给 html 或 body 设 100vh 或固定高度。整份文档和片段都可以，片段会自动补上外壳。`;

function failure(id, code, message, stopReason, text) {
  line({
    type: "failure",
    id,
    code,
    message,
    ...(stopReason ? { stopReason } : {}),
    ...(text ? { text } : {}),
  });
}

async function open(config) {
  // 契约是 src/server/pi-host/protocol.ts 的 OpenSession。缺字段时在这里说清楚缺了什么，
  // 否则第一次读到它只是个 TypeError，还会被下面 safe 列表外的通用文案折叠掉。
  const required = [
    "id",
    "instanceId",
    "sessionId",
    "sessionDirectory",
    "cwd",
    "agentDir",
    "extensionPath",
    "resources",
    "profile",
    "remote",
  ];
  const missing = required.filter((key) => config[key] === undefined);
  if (missing.length > 0) throw new Error(`open 命令缺少字段：${missing.join(", ")}`);
  if (config.resources?.kind !== "enabled" && config.resources?.kind !== "disabled")
    throw new Error(`open 命令的 resources.kind 非法：${JSON.stringify(config.resources)}`);
  const { root, sdk, runtime, model, thinking } = await createPiModelRuntime(config);
  mkdirSync(config.cwd, { recursive: true, mode: 0o700 });
  mkdirSync(config.sessionDirectory, { recursive: true, mode: 0o700 });
  const settingsManager = sdk.SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: true },
  });
  const controlledDir = join(config.cwd, ".sprout-pi");
  mkdirSync(controlledDir, { recursive: true, mode: 0o700 });
  const { default: sproutExtension } = await import(pathToFileURL(config.extensionPath).href);
  // Use the same TypeScript loader as the installed SDK for shared contract imports.
  const sdkRequire = createRequire(join(root, "package.json"));
  const { createJiti } = await import(pathToFileURL(sdkRequire.resolve("jiti")).href);
  const jiti = createJiti(import.meta.url);
  const { describeToolCall } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/lib/run-activity.ts"),
  );
  const { resolveWebAccessExtension, hostToolNames } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/extension/host-tools.ts"),
  );
  const { registerCurrentTimeTool, registerSleepTool } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/extension/time-tools.ts"),
  );
  const { registerGitReadTool } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/extension/git-read.ts"),
  );
  const { createRemoteClient } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/extension/remote-client.ts"),
  );
  const { registerRemoteTools } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/extension/remote-tools.ts"),
  );
  const { registerTaskTools } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/extension/task-tools.ts"),
  );
  const { registerInfoHubTools } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/extension/info-hub-tools.ts"),
  );
  const { infoHubToolInputSchemas } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/contracts/info-hub-query.ts"),
  );
  ({ turnContextPromptInputSchema } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/contracts/turn-context.ts"),
  ));
  ({ infoHubHintSchema } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/contracts/info-hub-hint.ts"),
  ));
  const { taskToolInputSchemas } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/contracts/task.ts"),
  );
  const { remoteToolInputSchemas } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/contracts/remote.ts"),
  );
  const { registerSproutMcp } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/extension/mcp-extension.ts"),
  );
  // 诊断入口与被诊断的 MCP 工具面同源：`sprout_status` 读 `mcpSurfaceDiagnostics()`，
  // 两者必须注册在同一个进程里，所以这里注册工具，而不是只在独立 CLI 的入口里注册。
  const { registerSproutStatus, setSproutHostFacts } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/extension/status.ts"),
  );
  const assistant = config.purpose === "assistant";
  assistantMode = assistant;
  const remoteClient = createRemoteClient(config.remote, { instanceId: config.instanceId });
  const { registerAssistantTools } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/extension/assistant-tools.ts"),
  );
  const { ASSISTANT_TOOL_SPEC } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/contracts/assistant.ts"),
  );
  ({ assistantInputContextSchema } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/contracts/assistant.ts"),
  ));
  const { MEMORY_TOOL_NAMES, filterMemorySkillPaths, memoryExtensionConfig } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/contracts/memory.ts"),
  );
  let memory = assistant ? { state: "disabled" } : (config.memory ?? { state: "disabled" });
  let memoryFactory;
  const downgradeMemory = () => {
    memory = {
      state: "unavailable",
      reason: "extension_load_failed",
      ...(memory.bank ? { bank: memory.bank } : {}),
    };
    memoryFactory = undefined;
    cleanupMemory();
  };
  if (memory.state === "ready") {
    try {
      memoryConfigDir = mkdtempSync(join(tmpdir(), "sprout-memory-"));
      const configPath = join(memoryConfigDir, "config.json");
      writeFileSync(configPath, JSON.stringify(memoryExtensionConfig(memory)), { mode: 0o600 });
      process.env.HINDSIGHT_CONFIG = configPath;
      if (memory.apiToken) process.env.HINDSIGHT_API_TOKEN = memory.apiToken;
      process.env.HINDSIGHT_BANK_ID = memory.bank;
      process.env.HINDSIGHT_API_URL = memory.apiUrl;
      process.env.HINDSIGHT_AUTO_UPDATE = "false";
      const module = await import(pathToFileURL(memory.bundlePath).href);
      if (typeof module.default !== "function") throw new Error("Invalid memory factory");
      memoryFactory = { name: "hindsight-memory", factory: module.default };
    } catch {
      downgradeMemory();
    }
  }
  const inheritHostResources = !assistant && config.resources.kind === "enabled";
  const inheritedPaths = inheritHostResources
    ? {
        skills: filterMemorySkillPaths(config.resources.skillPaths, memory.state),
        prompts: config.resources.promptPaths,
      }
    : { skills: [], prompts: [] };
  // 受控目录是分身自己的 loader/session 根。证据里报的 agentDir 就是这个对象里的值：
  // 不让「声明的目录」和「喂给 loader 的目录」变成两个可以互相飘的常量。
  const webAccessEntry = assistant ? undefined : resolveWebAccessExtension(config.agentDir);
  const loaderOptions = {
    cwd: config.cwd,
    agentDir: controlledDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    // pi-web-access 是宿主已安装的显式扩展，不走宿主扩展目录发现；缺席时 web_* 工具名也不进 allowlist。
    additionalExtensionPaths: webAccessEntry ? [webAccessEntry] : [],
    // 开关只搬 skills 与 prompt templates。extensions / themes / context files 仍然关闭：
    // 它们才是 P3 记录的失败与超时来源（context7、UnityMCP），也是跨 Project 内容泄漏的入口。
    additionalSkillPaths: inheritedPaths.skills,
    skillsOverride: (base) => {
      if (memory.state === "ready") return base;
      const excluded = new Set(
        base.skills
          .filter((skill) => skill.name === "hindsight-coding-agent")
          .map((skill) => skill.filePath),
      );
      inheritedPaths.skills = inheritedPaths.skills.filter((path) => !excluded.has(path));
      return {
        ...base,
        skills: base.skills.filter((skill) => !excluded.has(skill.filePath)),
      };
    },
    additionalPromptTemplatePaths: inheritedPaths.prompts,
    extensionFactories: assistant
      ? [
          {
            name: "sprout-assistant",
            factory: async (pi) => {
              registerAssistantTools(pi, remoteClient);
              registerSproutStatus(pi);
            },
          },
        ]
      : [
          // `noExtensions: true` 会连内建扩展一起关掉；codemode 与 tool_search 必须显式加回。
          { name: "codemode", factory: sdk.createCodemodeExtension() },
          { name: "tool-search", factory: sdk.createToolSearchExtension() },
          {
            name: "sprout-extension",
            factory: async (pi) => {
              sproutExtension(pi);
              let target = null;
              let mcp;
              const remote = {
                projectId: remoteClient.projectId,
                async request(request, signal) {
                  const response = await remoteClient.request(request, signal);
                  if (response.outcome === "response" && response.result.ok) {
                    const { call } = request;
                    const data = response.result.data;
                    let next;
                    if (call.type === "lease_get")
                      next =
                        data.lease.state === "held"
                          ? { machineId: call.input.machineId, generation: data.lease.generation }
                          : null;
                    if (call.type === "lease_mutate")
                      next =
                        call.input.action === "acquire" && data.state === "completed"
                          ? {
                              machineId: call.input.machineId,
                              generation: data.completedGeneration,
                            }
                          : null;
                    if (next !== undefined && JSON.stringify(next) !== JSON.stringify(target)) {
                      target = next;
                      const refreshed = await mcp.refresh();
                      // 不假装成功：目录已变但工具面没跟进时，把失败推到 stderr 的 runner 协议行外，
                      // 由 `sprout_status` 的诊断槽与验收脚本读取。
                      if (refreshed.outcome === "failed")
                        line({
                          type: "progress",
                          id: config.id,
                          kind: "mcp_surface_failed",
                          message: refreshed.error.message.slice(0, 500),
                        });
                    }
                  }
                  return response;
                },
              };
              mcp = await registerSproutMcp(pi, {
                remote,
                machineId: () => target?.machineId ?? null,
                authorizationGeneration: () => target?.generation ?? null,
              });
              registerRemoteTools(pi, remote);
              registerTaskTools(pi, remote);
              registerInfoHubTools(pi, remote);
              registerCurrentTimeTool(pi);
              registerSleepTool(pi);
              registerGitReadTool(pi);
              registerSproutStatus(pi);
            },
          },
        ],
    systemPrompt: `${config.profile.persona}${assistant ? ASSISTANT_GUIDE : ""}${HTML_ARTIFACT_GUIDE}`,
  };
  const baseFactories = loaderOptions.extensionFactories;
  if (memoryFactory) loaderOptions.extensionFactories = [...baseFactories, memoryFactory];
  let resourceLoader = new sdk.DefaultResourceLoader(loaderOptions);
  await resourceLoader.reload();
  let extensions = resourceLoader.getExtensions();
  const reloadWithoutMemory = async () => {
    downgradeMemory();
    loaderOptions.extensionFactories = baseFactories;
    inheritedPaths.skills = filterMemorySkillPaths(inheritedPaths.skills, memory.state);
    loaderOptions.additionalSkillPaths = inheritedPaths.skills;
    resourceLoader = new sdk.DefaultResourceLoader(loaderOptions);
    await resourceLoader.reload();
    extensions = resourceLoader.getExtensions();
    if (extensions.errors.length) throw new Error("Sprout extension 加载失败");
  };
  if (extensions.errors.some((error) => error.path === "<inline:hindsight-memory>"))
    await reloadWithoutMemory();
  if (extensions.errors.length) throw new Error("Sprout extension 加载失败");
  const existing = sdk.SessionManager.findById(
    config.cwd,
    config.sessionId,
    config.sessionDirectory,
  );
  if (config.sessionFile && !existsSync(config.sessionFile))
    throw new Error("持久 Pi session 文件缺失，拒绝创建替代会话");
  const sessionFile = config.sessionFile ?? existing;
  const manager = sessionFile
    ? sdk.SessionManager.open(sessionFile, config.sessionDirectory, config.cwd)
    : sdk.SessionManager.create(config.cwd, config.sessionDirectory, { id: config.sessionId });
  if (manager.getSessionId() !== config.sessionId) throw new Error("Pi session 身份不匹配");
  const createSession = () =>
    sdk.createAgentSession({
      cwd: config.cwd,
      agentDir: loaderOptions.agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: thinking,
      // MCP 工具必须以 `mcp__*` 出现在这一条 allowlist 里，否则 Pi 只把它们留在 registry、
      // 不声明给模型（`_isActivatable` 对 `direct` exposure 恒为 false，`setActiveTools` 也救不回来）。
      // 这是 `list_changed` 后新工具到不了模型工具面的根因，详见
      // `orchestrate/sprout-mio-r1/reports/remediation-extension.md`。
      tools: assistant
        ? ["sprout_status", ...Object.keys(ASSISTANT_TOOL_SPEC)]
        : [
            "sprout_status",
            ...(memoryFactory ? MEMORY_TOOL_NAMES : []),
            ...hostToolNames(webAccessEntry),
            "mcp__*",
            ...Object.keys(remoteToolInputSchemas),
            // sprout_chat_send 暂不声明给模型：宿主会把 run 的最终回答自动发到 Chat，
            // 再暴露发送工具会让同一轮出现「工具消息 + 最终消息」两条。registry 仍保留，
            // 后续跨 Chat 或 Agent 间通信再启用。
            ...Object.keys(taskToolInputSchemas).filter((name) => name !== "sprout_chat_send"),
            ...Object.keys(infoHubToolInputSchemas),
          ],
      resourceLoader,
      settingsManager,
      sessionManager: manager,
    });
  try {
    ({ session } = await createSession());
  } catch (error) {
    if (!memoryFactory) throw error;
    await reloadWithoutMemory();
    ({ session } = await createSession());
  }
  const memoryToolsReady = () => {
    const registered = new Set(session.getAllTools().map((tool) => tool.name));
    const active = new Set(session.getActiveToolNames());
    return MEMORY_TOOL_NAMES.every((name) => registered.has(name) && active.has(name));
  };
  if (memoryFactory && !memoryToolsReady()) {
    session.dispose();
    await reloadWithoutMemory();
    ({ session } = await createSession());
  }
  const subscribeSession = () =>
    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        line({
          type: "progress",
          id: config.id,
          kind: "text_delta",
          text: event.assistantMessageEvent.delta,
        });
      } else if (
        event.type === "message_update" &&
        event.assistantMessageEvent?.type === "text_end"
      ) {
        // 一个 text block 只发一条 text_end，宿主据此落一条独立的「中间说明」。
        const text = event.assistantMessageEvent.content;
        if (text) {
          line({
            type: "progress",
            id: config.id,
            kind: "text_end",
            text,
          });
        }
      } else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
        const activity = describeToolCall(
          event.toolName,
          event.type === "tool_execution_start" ? event.args : undefined,
          { cwd: config.cwd, nested: Boolean(event.parentToolCallId) },
        );
        line({
          type: "progress",
          id: config.id,
          kind: event.type === "tool_execution_start" ? "tool_start" : "tool_end",
          toolName: event.toolName,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
          activity,
          ...(event.type === "tool_execution_end"
            ? {
                isError: event.isError,
                ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
              }
            : {}),
        });
      }
    });
  subscribeSession();
  const extensionErrors = [];
  await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
  if (
    memoryFactory &&
    (!memoryToolsReady() ||
      extensionErrors.some((error) => error.extensionPath === "<inline:hindsight-memory>"))
  ) {
    session.dispose();
    await reloadWithoutMemory();
    ({ session } = await createSession());
    subscribeSession();
    extensionErrors.length = 0;
    await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
  }
  if (extensionErrors.length)
    throw new Error(
      `Sprout extension 初始化失败：${extensionErrors
        .map((error) =>
          error instanceof Error
            ? error.message
            : JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})),
        )
        .join("; ")}`,
    );
  if (session.model?.provider !== model.provider || session.model?.id !== model.id)
    throw new Error("Pi 实际模型与显式配置不匹配");
  const memorySnapshot =
    memory.state === "disabled"
      ? { state: "disabled" }
      : memory.state === "ready"
        ? { state: "ready", bank: memory.bank }
        : {
            state: "unavailable",
            reason: memory.reason,
            ...(memory.bank ? { bank: memory.bank } : {}),
          };
  const pkg = jsonFile(join(root, "package.json"), {});
  // 宿主实况在 ready 之前写进 `sprout_status` 的槽：模型调它的时候读到的是这一轮会话的
  // 真实事实（装载了哪些 extension、继承开关、真实模型、真正声明出去的工具有几个），
  // 不是 extension 自己猜的常量。工具面在 allowlist 之后已定，这里读到的就是终值。
  {
    const facts = {
      source: "pi-host-runner",
      // 装载方式由装载者自己报：文件名就是装载它的那一个。改名会反映到载荷上，
      // 不是 extension 里写死的常量（那份常量在 `src/extension/status.ts` 只作为降级值）。
      loader: basename(fileURLToPath(import.meta.url)).replace(/\.mjs$/, ""),
      runtime: { node: process.versions.node, pi: pkg.version ?? "unknown" },
      memory: memorySnapshot,
      host: {
        inheritHostResources,
        extensions: extensions.extensions.map((extension) =>
          extension.path.replace(/^<inline:(.*)>$/, "$1"),
        ),
      },
      session: {
        // 会话身份与落盘文件：`manager` 就是喂给 Pi 的那个 session manager，
        // 上面已经核对过它的 id 与 open 传入的 id 一致。
        id: manager.getSessionId(),
        file: session.sessionFile ?? null,
        model: `${session.model.provider}/${session.model.id}`,
        thinking: session.thinkingLevel,
        activeTools: session.getActiveToolNames().length,
        registeredTools: session.getAllTools().length,
      },
      run: { id: config.id },
    };
    if (!facts.session.activeTools) throw new Error("Pi 工具面为空，拒绝写宿主实况");
    // 自守：注册了却不声明给模型是 Pi 的真实状态（不在 `tools` allowlist 里就会被丢弃）。
    // 没被声明的工具对模型不存在，所以这里不静默放行，直接让 open 失败。
    if (!session.getActiveToolNames().includes("sprout_status"))
      throw new Error("sprout_status 未进入 Pi 工具面，拒绝把诊断入口缺失的会话交给模型");
    setSproutHostFacts(facts);
  }
  if (assistant) {
    const allowed = ["sprout_status", ...Object.keys(ASSISTANT_TOOL_SPEC)].sort();
    const registered = session
      .getAllTools()
      .map((tool) => tool.name)
      .sort();
    if (JSON.stringify(registered) !== JSON.stringify(allowed))
      throw new Error("Assistant tool registry violates purpose boundary");
  }
  // 边界证据随 ready 快照返回：谁被加载、谁没被加载由 loader 自己的读取结果回答，
  // 不靠读代码推断。只写名字与计数，不写 skill/prompt 正文。
  line({
    type: "ready",
    id: config.id,
    snapshot: {
      memory: memorySnapshot,
      provider: session.model.provider,
      model: session.model.id,
      thinking: session.thinkingLevel,
      tools: session.getActiveToolNames().sort(),
      // registry 里注册的全部工具：与 tools（声明给模型的那一份）分开记录，
      // 因为「注册成功但不在 allowlist」是 Pi 的一个真实状态（`mcp__*` 之外的宿主工具
      // 一旦漏进 allowlist 就这样丢），两张表分开才能看出差别。
      registeredTools: session
        .getAllTools()
        .map((tool) => tool.name)
        .sort(),
      extensions: extensions.extensions.map((extension) =>
        extension.path.replace(/^<inline:(.*)>$/, "$1"),
      ),
      resources: {
        inheritHostResources,
        agentDir: loaderOptions.agentDir,
        hostAgentDir: config.agentDir,
        skillPaths: inheritedPaths.skills,
        promptPaths: inheritedPaths.prompts,
        skills: resourceLoader
          .getSkills()
          .skills.map((skill) => skill.name)
          .sort(),
        prompts: resourceLoader
          .getPrompts()
          .prompts.map((prompt) => prompt.name)
          .sort(),
        themes: resourceLoader
          .getThemes()
          .themes.map((theme) => theme.name)
          .sort(),
        contextFiles: resourceLoader
          .getAgentsFiles()
          .agentsFiles.map((file) => file.path)
          .sort(),
        // 模型实际收到的系统提示长度：技能文本进的是这里，不是 loader 的 base prompt。
        systemPromptChars: (session.systemPrompt ?? "").length,
      },
      sessionId: config.sessionId,
      sessionFile: session.sessionFile,
      cwd: config.cwd,
      sdkVersion: pkg.version,
      purpose: config.purpose ?? "worker",
      profile: config.profile,
    },
  });
}

async function prompt(command) {
  prompting = true;
  const start = session.messages.length;
  const assistantMessages = () =>
    session.messages.slice(start).filter((entry) => entry.role === "assistant");
  const replyText = () =>
    assistantMessages()
      .map((entry) =>
        entry.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
      )
      .join("\n\n")
      .trim();
  line({ type: "input_delivered", id: command.id, messageId: command.messageId });
  try {
    await promptWithTurnContext(
      session,
      command,
      turnContextPromptInputSchema,
      submittedContexts,
      line,
    );
    const assistants = assistantMessages();
    const text = replyText();
    const failed = assistants.find(
      (entry) => entry.stopReason === "error" || entry.stopReason === "aborted",
    );
    if (failed) {
      failure(
        command.id,
        failed.stopReason === "error" ? "model_error" : "model_aborted",
        "Pi 模型未正常完成本轮",
        failed.stopReason,
        text,
      );
      return;
    }
    const last = assistants.at(-1);
    if (last?.stopReason !== "stop") {
      failure(
        command.id,
        "invalid_stop_reason",
        "Pi 没有返回正常停止原因",
        last?.stopReason ?? "missing",
        text,
      );
      return;
    }
    if (!text) {
      failure(command.id, "invalid_reply", "Pi 回复为空", last.stopReason);
      return;
    }
    line({ type: "settled", id: command.id, text, stopReason: last.stopReason });
  } catch {
    failure(command.id, "prompt_failed", "Pi prompt 调用失败", undefined, replyText());
  } finally {
    prompting = false;
  }
}

async function deliverSteer(command) {
  if (!session.isStreaming) {
    line({
      type: "input_rejected",
      id: command.id,
      messageId: command.messageId,
      reason: "Pi 会话当前不在运行，消息未进入本轮",
    });
    return;
  }
  try {
    const context =
      command.assistantContext === undefined
        ? undefined
        : assistantInputContextSchema.parse(command.assistantContext);
    if (
      context &&
      (!assistantMode ||
        context.runId !== command.id ||
        context.messageId !== command.messageId ||
        Buffer.byteLength(context.serializedText, "utf8") > 8192 ||
        createHash("sha256").update(context.serializedText).digest("hex") !== context.contentHash)
    )
      throw new Error("assistant_context_identity_mismatch");
    const text = context ? `${context.serializedText}\n\n${command.text}` : command.text;
    await session.steer(text, undefined, { source: "rpc" });
    line({
      type: "input_delivered",
      id: command.id,
      messageId: command.messageId,
      ...(context ? { assistantContextHash: context.contentHash } : {}),
    });
  } catch {
    line({
      type: "input_rejected",
      id: command.id,
      messageId: command.messageId,
      reason: "Pi 会话拒绝了该消息",
    });
  }
}

async function close() {
  if (closing) return;
  closing = true;
  try {
    await session?.abort();
  } finally {
    session?.dispose();
    cleanupMemory();
    input.close();
    process.exit(0);
  }
}

input.on("line", (raw) => {
  let command;
  try {
    command = JSON.parse(raw);
  } catch {
    return;
  }
  if (command.type === "open" && !opening) {
    opening = true;
    openId = command.id;
    void open(command).catch((error) => {
      const safe = [
        "open 命令",
        "找不到 Pi SDK",
        "Agent profile 或 Pi",
        "magpie 需要",
        "指定的 Pi model",
        "Pi provider",
        "Pi 不支持",
        "Sprout extension",
        "持久 Pi session",
        "Pi session 身份",
        "Pi 实际模型",
        // 工具面自守的失败原因必须原样带给宿主：把「诊断入口缺失」吞成一句通用的
        // 「初始化失败」，等于在修诊断入口的同时又丢了一次诊断。
        "Pi 工具面为空",
        "sprout_status 未进入",
      ];
      const known = safe.some((prefix) => error.message?.startsWith(prefix));
      const message = known ? error.message : "Pi session 初始化失败，请检查宿主 SDK 与配置";
      // 帧里给宿主的是可读原因，真实原因与栈留在 stderr：门禁日志（与 _tail 输出）能收到它，
      // 而宿主 UI 不必看一坨 TypeError。
      if (!known) console.error(`pi-host-runner open failed: ${error?.stack ?? error}`);
      failure(command.id, "session_open_failed", message);
      session?.dispose();
      input.close();
      process.exitCode = 1;
    });
  } else if (command.type === "info_hub_hint" && session && prompting && !closing) {
    const hint = infoHubHintSchema.safeParse(command.hint);
    if (
      hint.success &&
      hint.data.runId === command.id &&
      command.id === openId &&
      session.isStreaming
    ) {
      void session
        .steer(JSON.stringify({ channel: "sprout_info_hub_hint", ...hint.data }), undefined, {
          source: "rpc",
        })
        .catch(() => {});
    }
  } else if (command.type === "prompt" && session && !prompting && !closing) {
    void prompt(command);
  } else if (command.type === "steer" && session && !closing) {
    void deliverSteer(command);
  } else if (command.type === "abort") {
    void session?.abort();
  } else if (command.type === "close") {
    void close();
  }
});
input.on("close", () => {
  if (!closing) void close();
});
process.on("SIGTERM", () => {
  void close();
});
process.on("uncaughtException", () => {
  failure(openId, "runner_crashed", "Pi runner 异常退出");
  process.exit(1);
});
